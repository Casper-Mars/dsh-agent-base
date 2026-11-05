/**
 * 任务定义持久化（`<tasksDir>/<id>.json`）。
 *
 * 存储位置（技术方案 D4）：任务定义放 `<workspace>/.agent-base/tasks/`，
 * `scheduler.tasksDir` **只接受相对 workspace 的路径**。理由：
 *   1. workspace 是插件唯一的固定根目录，任务定义与任务程序同处一棵目录树，
 *      相对路径（`task_path`）才有稳定含义；
 *   2. 定义是「用户资产」，放在 workspace 内可被用户直接查看 / 备份 / 迁移；
 *      插件私有数据目录（若存在）不适合承载需要人工编辑的文件；
 *   3. 相对路径 + `resolve` 后二次校验，杜绝 `..` / 绝对路径把读写引到
 *      workspace 之外。
 *
 * 关键约束：
 *   - **id 防目录穿越**：拼路径前必须过 {@link assertTaskId}（拒绝 `/`、`\`、
 *     `..`、空串、空字符、超长、非法字符）；
 *   - **损坏文件跳过**：`list()` 遇到 JSON 解析失败 / 结构非法只记入 `corrupted`，
 *     不抛异常、不中断其它任务；
 *   - **id 必须等于文件名骨架**：`tasks/dup.json` 里写 `id:"other"` 属于损坏
 *     （否则同 id 会装出多份 timer，`stop` 也无法按 id 收敛），跳过并 warn；
 *   - **原子写**：同目录临时文件 + `rename`，避免崩溃留下半截 JSON；
 *   - **无 git 语义**：base 没有资产仓库，本模块只负责落盘（rsi 的
 *     `commitAssets` / `GitRunner` 能力已删除）。
 */
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { TaskDef } from './types.js'

/** 任务 id 白名单：字母/数字开头，允许 `.` `_` `-`。 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** 任务文件扩展名。 */
export const TASK_FILE_EXT = '.json'

/** 默认任务目录（相对 workspace）：`.agent-base/tasks`。 */
export const DEFAULT_TASKS_SUBDIR = join('.agent-base', 'tasks')

/** `cooldown_ms` 允许上限（1 小时）。 */
export const MAX_COOLDOWN_MS = 3_600_000

/** 任务存储契约错误（id 非法 / 写入内容非法 / 目录越界）。 */
export class TaskStoreError extends Error {
  constructor(message: string) {
    super(`[scheduler/store] ${message}`)
    this.name = 'TaskStoreError'
  }
}

/** 日志出口：兼容统一门面与简单回调。 */
export type TaskStoreLogger =
  | { warn(message: string, meta?: unknown): void }
  | ((message: string) => void)

function warnOf(logger: TaskStoreLogger | undefined): (message: string) => void {
  if (logger === undefined) return () => {}
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

/**
 * 校验任务 id 可作为单段文件名。
 *
 * 拒绝 `''` / `.` / `..` / 含路径分隔符 / 反斜杠 / 空字符 / 超长 / 非法字符，
 * 并给出具体原因（调用方与测试可直接断言消息）。
 */
export function assertTaskId(id: unknown): string {
  if (typeof id !== 'string' || id === '') {
    throw new TaskStoreError(`任务 id 必须是非空字符串，实际为 ${String(id)}`)
  }
  if (id === '.' || id === '..') {
    throw new TaskStoreError(`任务 id 不能是特殊路径段 ${JSON.stringify(id)}`)
  }
  if (id.includes('/') || id.includes('\\')) {
    throw new TaskStoreError(`任务 id 不得包含路径分隔符：${JSON.stringify(id)}`)
  }
  if (id.includes('\0')) {
    throw new TaskStoreError(`任务 id 不得包含空字符：${JSON.stringify(id)}`)
  }
  if (!TASK_ID_PATTERN.test(id)) {
    throw new TaskStoreError(
      `任务 id 必须匹配 ${TASK_ID_PATTERN}（字母/数字开头，≤128 字符），实际为 ${JSON.stringify(id)}`,
    )
  }
  return id
}

/**
 * 解析任务目录（技术方案 D4：默认 `<workspace>/.agent-base/tasks`）。
 *
 * @param workspace 固定工作区绝对路径。
 * @param tasksDir  可选覆盖；**只接受相对 workspace 的路径**，解析后必须仍在
 *                  workspace 内（`..` 越界、绝对路径一律抛错）。
 */
export function resolveTasksDir(workspace: string, tasksDir?: string): string {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new TaskStoreError('workspace 必须是非空字符串')
  }
  if (!isAbsolute(workspace)) {
    throw new TaskStoreError(`workspace 必须是绝对路径，实际为 ${JSON.stringify(workspace)}`)
  }
  const root = resolve(workspace)
  if (tasksDir === undefined) return resolve(root, DEFAULT_TASKS_SUBDIR)
  if (typeof tasksDir !== 'string' || tasksDir.trim() === '') {
    throw new TaskStoreError('tasksDir 必须是非空字符串')
  }
  // 绝对路径直接拒绝：即使它「恰好」落在 workspace 内，配置语义也要求相对路径，
  // 否则换机 / 换 workspace 后配置会静默指向旧目录。
  if (isAbsolute(tasksDir)) {
    throw new TaskStoreError(
      `tasksDir 必须是相对 workspace 的路径，不得为绝对路径：${JSON.stringify(tasksDir)}`,
    )
  }
  const target = resolve(root, tasksDir)
  const rel = relative(root, target)
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (outside) {
    throw new TaskStoreError(
      `tasksDir 解析后越出 workspace（${JSON.stringify(tasksDir)} → ${target}）`,
    )
  }
  return target
}

/** 判断未知值是否满足 {@link TaskDef} 的判别联合结构。 */
export function isTaskDef(value: unknown): value is TaskDef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>

  if (typeof record.id !== 'string' || !TASK_ID_PATTERN.test(record.id)) return false
  if (typeof record.name !== 'string' || record.name.trim() === '') return false
  if (typeof record.cron !== 'string') return false
  if (typeof record.enabled !== 'boolean') return false
  if (record.session_id !== undefined && typeof record.session_id !== 'string') return false

  const cooldown = record.cooldown_ms
  if (cooldown !== undefined) {
    if (typeof cooldown !== 'number' || !Number.isFinite(cooldown)) return false
    if (cooldown < 0 || cooldown > MAX_COOLDOWN_MS) return false
  }

  const kind = record.kind
  if (kind === undefined || kind === 'script') {
    // script（kind 可省略）：必须有非空 task_path，且不得出现 text。
    if (typeof record.task_path !== 'string' || record.task_path.trim() === '') return false
    if (record.text !== undefined) return false
    return true
  }
  if (kind === 'text') {
    // text：必须有 text（允许空串，由运行期按「空文本 = quiet」处理），
    // 且不得出现 task_path。
    if (typeof record.text !== 'string') return false
    if (record.task_path !== undefined) return false
    return true
  }
  return false
}

/** `list()` 结果：有效任务 + 损坏文件名（不含扩展名）。 */
export interface TaskListResult {
  readonly tasks: TaskDef[]
  readonly corrupted: string[]
}

/** {@link TaskStore} 构造选项。 */
export interface TaskStoreOptions {
  /** 任务定义目录（绝对路径，通常来自 {@link resolveTasksDir}）。 */
  readonly tasksDir: string
  /** 日志出口。 */
  readonly logger?: TaskStoreLogger
}

/** 任务清单持久化。 */
export class TaskStore {
  readonly tasksDir: string
  private readonly warn: (message: string) => void

  constructor(options: TaskStoreOptions) {
    if (typeof options.tasksDir !== 'string' || options.tasksDir.trim() === '') {
      throw new TaskStoreError('tasksDir 必须是非空字符串')
    }
    this.tasksDir = options.tasksDir
    this.warn = warnOf(options.logger)
  }

  /** 任务定义文件的绝对路径（id 先过安全校验）。 */
  filePath(id: string): string {
    return join(this.tasksDir, `${assertTaskId(id)}${TASK_FILE_EXT}`)
  }

  /**
   * 列出全部任务（按 id 升序）并归集损坏文件。
   *
   * 「损坏」判定包含两类：JSON 解析失败 / 结构非法，以及**文件内 `id` 与文件名
   * 骨架不一致**（`dup.json` 内 `id` 为 `other`）。后者不校验会导致同一 id 在多份
   * 文件里出现，装出多份 timer 且 `stop` 只能清掉其中一份，故直接跳过并 warn。
   */
  list(): TaskListResult {
    const tasks: TaskDef[] = []
    const corrupted: string[] = []
    if (!existsSync(this.tasksDir)) return { tasks, corrupted }

    let entries: string[]
    try {
      entries = readdirSync(this.tasksDir)
    } catch {
      return { tasks, corrupted }
    }

    for (const entry of entries) {
      if (!entry.endsWith(TASK_FILE_EXT)) continue
      const stem = entry.slice(0, -TASK_FILE_EXT.length)
      let task: TaskDef | undefined
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(this.tasksDir, entry), 'utf8'))
        if (isTaskDef(parsed)) task = parsed
      } catch {
        task = undefined
      }
      if (task === undefined) {
        corrupted.push(stem)
        this.warn(`任务文件 ${entry} 解析失败或结构非法，已跳过`)
      } else if (task.id !== stem) {
        // 文件名与 id 不一致：视为损坏项（双份 timer / stop 残留的根源）。
        corrupted.push(stem)
        this.warn(
          `任务文件 ${entry} 内的 id（${task.id}）与文件名（${stem}）不一致，已跳过`,
        )
      } else {
        tasks.push(task)
      }
    }

    tasks.sort((left, right) => left.id.localeCompare(right.id))
    return { tasks, corrupted }
  }

  /** 读取单个任务；不存在 / 损坏返回 `undefined`。id 非法仍抛错（编程错误要响亮）。 */
  get(id: string): TaskDef | undefined {
    const path = this.filePath(id)
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return isTaskDef(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 写入 / 覆盖任务（原子写：同目录 tmp → rename）。
   *
   * 失败时清理临时文件并抛 {@link TaskStoreError}；`rename` 是原子替换，
   * 因此写入失败不会破坏已存在的旧文件。
   */
  save(task: TaskDef): void {
    if (!isTaskDef(task)) {
      throw new TaskStoreError(`save 的任务结构非法：${JSON.stringify(task)}`)
    }
    const path = this.filePath(task.id)
    mkdirSync(this.tasksDir, { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      writeFileSync(tmp, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
      renameSync(tmp, path)
    } catch (error) {
      rmSync(tmp, { force: true })
      throw new TaskStoreError(
        `写入任务 ${task.id} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 删除任务文件；不存在返回 `false`（不抛错）。 */
  remove(id: string): boolean {
    const path = this.filePath(id)
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  }
}

/** 创建任务存储。 */
export function createTaskStore(options: TaskStoreOptions): TaskStore {
  return new TaskStore(options)
}
