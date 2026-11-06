/**
 * 任务定义工具（8 个）：`task_create` / `task_list` / `task_get` /
 * `task_update` / `task_delete` / `task_enable` / `task_disable` / `task_run_now`。
 *
 * 契约要点（与 rsi-agent 的差异按 base 方案）：
 *   1. **task_path 不设目录白名单**：相对 workspace 或绝对路径都接受，扩展名
 *      限 `.js` / `.mjs` / `.cjs` / `.ts`；创建 / 更新期复用
 *      {@link validateScript} 做强校验（存在、普通文件、可读），但不做语法解析；
 *   2. **kind 交叉约束**：`kind` 缺省 `script`；script 必须有 `task_path` 且不得
 *      出现 `text`；text 必须有 `text` 且不得出现 `task_path`；
 *   3. **session_id 只在允许时出现**：`allowCustomSession !== true` 时
 *      parameters 里没有该字段，`additionalProperties: false` 即拒绝传入；
 *      但整文件重写（update / enable / disable）仍保留磁盘上已有的
 *      `session_id`，不会因为关闭开关而抹掉；
 *   4. **创建时不校验 session 是否存在**：允许先建任务、后建会话；
 *   5. **单一写入入口**：全部写动作经 {@link TaskStoreLike}；写成功后调用
 *      `onChange`（生产 = service.reload），回调抛错只 warn，不影响工具成功；
 *   6. **语义错误一律抛错**（中文原因），不返回 `{ ok: false }`。
 *
 * 零运行时依赖：`dsh-tools` 只做 type-only import。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { parseCron } from './cron.js'
import { assertTaskId } from './store.js'
import type { TaskListResult } from './store.js'
import type { ScriptTaskDef, TaskDef, TaskKind, TaskRunOutcome, TextTaskDef } from './types.js'
import { TaskPathError, resolveScriptPath, validateScript } from './validate.js'

/** 工具错误前缀（错误信息统一可辨识）。 */
export const SCHEDULER_TOOLS_TAG = '[scheduler/tools]'

/** 8 个工具名（注册前预检 / 测试断言用）。 */
export const SCHEDULER_TOOL_NAMES: readonly string[] = Object.freeze([
  'task_create',
  'task_list',
  'task_get',
  'task_update',
  'task_delete',
  'task_enable',
  'task_disable',
  'task_run_now',
])

/** 调度工具语义错误（入参非法 / id 不存在 / 文件不可用）。 */
export class SchedulerToolError extends Error {
  constructor(message: string) {
    super(`${SCHEDULER_TOOLS_TAG} ${message}`)
    this.name = 'SchedulerToolError'
  }
}

/**
 * 工具层需要的任务存储最小面（`TaskStore` 结构上完全满足；单测可注入）。
 */
export interface TaskStoreLike {
  /** 任务定义目录（绝对路径）。 */
  readonly tasksDir: string
  /** 列出全部任务并归集损坏文件。 */
  list(): TaskListResult
  /** 读取单个任务。 */
  get(id: string): TaskDef | undefined
  /** 写入 / 覆盖任务定义。 */
  save(task: TaskDef): void
  /** 删除任务定义；不存在返回 `false`。 */
  remove(id: string): boolean
}

/** {@link createSchedulerTools} 依赖。 */
export interface SchedulerToolsOptions {
  /** 任务定义存储（`TaskStore` 结构兼容）。 */
  readonly store: TaskStoreLike
  /** 解析 `task_path` 相对路径的基准（固定 workspace 绝对路径）。 */
  readonly workspace: string
  /** 是否允许 script 任务；缺省 `true`。关闭后已有 script 任务仍可读。 */
  readonly allowScript?: boolean
  /** 是否允许自定义 `session_id`；缺省 `false`（仅控制 schema 与写入）。 */
  readonly allowCustomSession?: boolean
  /** 写成功后的回调（生产环境注入 `() => service.reload()`）。 */
  readonly onChange?: () => void
  /** `task_run_now` 的执行入口；缺省时该工具给出明确错误。 */
  readonly runNow?: (id: string) => Promise<TaskRunOutcome>
  /** 日志出口（`onChange` 抛错时只 warn）。 */
  readonly logger?: { warn(message: string, meta?: unknown): void }
}

/** 对外暴露的任务视图（非破坏性警告不阻断读取）。 */
export interface TaskView {
  readonly id: string
  readonly name: string
  readonly cron: string
  readonly enabled: boolean
  readonly kind: TaskKind
  /** script 任务的任务程序入口（text 任务省略）。 */
  readonly task_path?: string
  /** text 任务的投递正文（script 任务省略）。 */
  readonly text?: string
  /** 自定义投递目标（有则返回）。 */
  readonly session_id?: string
  /** 非破坏性提示（例如程序当前不存在）；始终返回数组。 */
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// 入参校验
// ---------------------------------------------------------------------------

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new SchedulerToolError(
      `入参必须是对象，实际为 ${args === null ? 'null' : Array.isArray(args) ? 'array' : typeof args}`,
    )
  }
  return args as Record<string, unknown>
}

/** 校验任务 id（单段文件名骨架，防目录穿越）。 */
export function validateTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError('id 必须是非空字符串')
  }
  try {
    return assertTaskId(value.trim())
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^\[scheduler\/store\]\s*/, '') : String(error)
    throw new SchedulerToolError(`id 非法：${detail}`)
  }
}

/** 校验任务名称。 */
function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError('name 必须是非空字符串')
  }
  return value
}

/** 校验 enabled。 */
function validateEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new SchedulerToolError(
      `enabled 必须是 boolean，实际为 ${value === null ? 'null' : typeof value}`,
    )
  }
  return value
}

/** 校验 kind（只接受 script / text）。 */
function validateKind(value: unknown): TaskKind {
  if (value !== 'script' && value !== 'text') {
    throw new SchedulerToolError(`kind 只能是 "script" 或 "text"，实际为 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 校验 cron：**只接受 5 段**（分 时 日 月 周），6 段 / 带秒表达式一律拒绝。
 *
 * 复用 {@link parseCron} 的严格校验，错误信息保留其中文说明。
 */
export function validateTaskCron(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError('cron 必须是非空字符串（应含 5 段（分 时 日 月 周））')
  }
  const expr = value.trim()
  try {
    parseCron(expr)
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^\[cron\]\s*/, '') : String(error)
    throw new SchedulerToolError(`cron 非法：${detail}`)
  }
  return expr
}

/** 校验 text 正文（允许空串，运行期按「空文本 = quiet」处理）。 */
function validateTextValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SchedulerToolError('text 必须是字符串')
  }
  return value
}

/** 校验自定义 session_id（只做形态校验，不检查会话是否存在）。 */
function validateSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError('session_id 必须是非空字符串')
  }
  return value
}

/**
 * 校验 `task_path`：形态 + 解析（相对 workspace / 绝对路径）+ 存在性 + 可读性。
 *
 * 返回用户传入的（已 trim）路径，落盘时原样保留；错误信息带解析后的绝对路径
 * 与具体原因（not found / not a file / not readable）。
 */
async function validateTaskPath(workspace: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError(
      'task_path 必须是非空字符串（相对 workspace 或绝对路径，扩展名限 .js / .mjs / .cjs / .ts）',
    )
  }
  const taskPath = value.trim()
  try {
    await validateScript(workspace, taskPath)
  } catch (error) {
    if (error instanceof TaskPathError) {
      // 形态错误（扩展名等）在解析前失败，补上解析后的绝对路径，保证诊断可定位。
      const absolute = error.path ?? resolveScriptPath(workspace, taskPath)
      const suffix = error.path === undefined ? `（${absolute}）` : ''
      throw new SchedulerToolError(`task_path 校验失败：${error.reason}${suffix}`)
    }
    throw new SchedulerToolError(
      `task_path 校验失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return taskPath
}

// ---------------------------------------------------------------------------
// 任务构造 / 视图
// ---------------------------------------------------------------------------

function kindOf(task: TaskDef): TaskKind {
  return task.kind === 'text' ? 'text' : 'script'
}

function scriptPathOf(task: TaskDef): string | undefined {
  return task.kind === 'text' ? undefined : task.task_path
}

function textOf(task: TaskDef): string | undefined {
  return task.kind === 'text' ? task.text : undefined
}

/** 构造一条严格符合 {@link TaskDef} 的定义（kind 判别联合分别成对象）。 */
function assembleTask(input: {
  readonly id: string
  readonly name: string
  readonly cron: string
  readonly enabled: boolean
  readonly sessionId?: string
  readonly cooldownMs?: number
} & (
  | { readonly kind: 'script'; readonly taskPath: string }
  | { readonly kind: 'text'; readonly text: string }
)): TaskDef {
  const common = {
    id: input.id,
    name: input.name,
    cron: input.cron,
    enabled: input.enabled,
    ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
    ...(input.cooldownMs === undefined ? {} : { cooldown_ms: input.cooldownMs }),
  }
  if (input.kind === 'text') {
    const task: TextTaskDef = { ...common, kind: 'text', text: input.text }
    return task
  }
  const task: ScriptTaskDef = { ...common, task_path: input.taskPath }
  return task
}

/** 从一条已有定义取出可复用的公共字段。 */
function carryOver(task: TaskDef): {
  id: string
  name: string
  cron: string
  enabled: boolean
  sessionId?: string
  cooldownMs?: number
} {
  return {
    id: task.id,
    name: task.name,
    cron: task.cron,
    enabled: task.enabled,
    ...(task.session_id === undefined ? {} : { sessionId: task.session_id }),
    ...(task.cooldown_ms === undefined ? {} : { cooldownMs: task.cooldown_ms }),
  }
}

/**
 * 非破坏性警告：script 任务程序当前是否可用。
 *
 * 复用 {@link validateScript}（L1 形态 + L2 存在性 / 可读性），与 runner 的触发期
 * 校验口径完全一致：手工落盘 / 迁移来的 `.py` 等非法扩展名也会在这里提示，
 * 而不是等到触发时才 failed/runtime。
 */
async function scriptWarnings(workspace: string, taskPath: string): Promise<string[]> {
  try {
    await validateScript(workspace, taskPath)
    return []
  } catch (error) {
    const reason = error instanceof TaskPathError ? error.reason : String(error)
    return [`任务程序当前不可用：${reason}`]
  }
}

/** 任务定义 → 对外视图（script / text 字段按 kind 裁剪，warnings 始终返回）。 */
export async function toTaskView(workspace: string, task: TaskDef): Promise<TaskView> {
  const base = {
    id: task.id,
    name: task.name,
    cron: task.cron,
    enabled: task.enabled,
    ...(task.session_id === undefined ? {} : { session_id: task.session_id }),
  }
  if (task.kind === 'text') {
    return { ...base, kind: 'text', text: task.text, warnings: [] }
  }
  return {
    ...base,
    kind: 'script',
    task_path: task.task_path,
    warnings: await scriptWarnings(workspace, task.task_path),
  }
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 任务定义文件的绝对路径。 */
function taskFilePath(store: TaskStoreLike, id: string): string {
  return join(store.tasksDir, `${id}.json`)
}

/** 任务定义文件是否已存在（含损坏文件，避免 create 静默覆盖）。 */
function taskFileExists(store: TaskStoreLike, id: string): boolean {
  return existsSync(taskFilePath(store, id))
}

/** 读取必须存在的任务；不存在即抛错。 */
function requireTask(store: TaskStoreLike, id: string): TaskDef {
  const task = store.get(id)
  if (task === undefined) {
    throw new SchedulerToolError(`任务 ${id} 不存在`)
  }
  return task
}

/** 写后通知（`onChange` 抛错不得让「已落盘」的写动作反向失败）。 */
function notifyChange(options: SchedulerToolsOptions): void {
  if (options.onChange === undefined) return
  try {
    options.onChange()
  } catch (error) {
    options.logger?.warn(
      `任务变更后的调度器 reload 失败（文件已落盘）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// output.schema
// ---------------------------------------------------------------------------

/** 单条任务视图。 */
const TASK_VIEW_SCHEMA: ToolDefinition['output']['schema'] = {
  type: 'object',
  description: '任务视图（script / text 字段按 kind 裁剪，warnings 始终返回）',
  properties: {
    id: { type: 'string', description: '任务唯一标识' },
    name: { type: 'string', description: '人类可读名称' },
    cron: { type: 'string', description: '5 段 cron（分 时 日 月 周）' },
    enabled: { type: 'boolean', description: '是否启用' },
    kind: { type: 'string', enum: ['script', 'text'], description: '任务类型' },
    task_path: {
      type: 'string',
      description: '任务程序入口（相对 workspace 或绝对路径；text 任务省略）',
    },
    text: { type: 'string', description: '投递正文（script 任务省略）' },
    session_id: { type: 'string', description: '自定义投递目标会话 id（有则返回）' },
    warnings: {
      type: 'array',
      description: '非破坏性提示（例如程序当前不存在）',
      items: { type: 'string' },
    },
  },
  required: ['id', 'name', 'cron', 'enabled', 'kind', 'warnings'],
  additionalProperties: false,
}

/** 写类工具出参：`{ ok, task }`。 */
const TASK_WRITE_OUTPUT_SCHEMA: ToolDefinition['output']['schema'] = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '写库是否成功（成功即 true）' },
    task: TASK_VIEW_SCHEMA,
  },
  required: ['ok', 'task'],
  additionalProperties: false,
}

/** `task_get` 出参：`{ task }`。 */
const TASK_GET_OUTPUT_SCHEMA: ToolDefinition['output']['schema'] = {
  type: 'object',
  properties: { task: TASK_VIEW_SCHEMA },
  required: ['task'],
  additionalProperties: false,
}

/** `task_delete` 出参：`{ ok, id }`。 */
const TASK_DELETE_OUTPUT_SCHEMA: ToolDefinition['output']['schema'] = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否删除成功' },
    id: { type: 'string', description: '被删除的任务 id' },
  },
  required: ['ok', 'id'],
  additionalProperties: false,
}

/** `task_list` 出参：`{ tasks, corrupted? }`。 */
const TASK_LIST_OUTPUT_SCHEMA: ToolDefinition['output']['schema'] = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: '有效任务清单（按 id 升序）',
      items: TASK_VIEW_SCHEMA,
    },
    corrupted: {
      type: 'array',
      description: '解析失败 / 结构非法 / 文件名与 id 不一致的任务文件名（不含扩展名）',
      items: { type: 'string' },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
}

/**
 * `task_run_now` 出参：运行结局（六态判别联合）。
 *
 * 以 `oneOf` 按 `kind` 收紧 required：每个分支用 `const` 固定 `kind`，保证
 * 「恰好命中一个分支」；这样 failed 必须带 failureKind / notified /
 * consecutiveFailures，woke 必须带 data / targets，queued 必须带 targets，
 * missed 必须带 scheduledAt（ISO 字符串，见 {@link serializeRunOutcome}）。
 *
 * 注：dsh-tools 的 schema 子集不允许同一节点同时声明 `type` 与 `oneOf`
 * （`cannot declare both type and oneOf`），且结构化输出的 object-root 约束只
 * 适用于 subagent / workflow，不适用于工具出参；工具出参在注册期由
 * `assertSupportedJsonSchema` 校验（任意 JSON 根）。因此这里用 oneOf 根表达
 * 判别联合，而不是 `type: 'object'` + 无法表达的按 kind 条件 required。
 */
const TASK_RUN_OUTPUT_SCHEMA: ToolDefinition['output']['schema'] = {
  description: '单次任务运行的结局（六态判别联合，按 kind 收紧 required）',
  oneOf: [
    {
      type: 'object',
      description: 'quiet：执行完成但无需投递',
      properties: {
        kind: { type: 'string', const: 'quiet' },
        reason: { type: 'string', description: '结局说明' },
        detail: { type: 'string', description: '补充细节' },
      },
      required: ['kind', 'reason'],
    },
    {
      type: 'object',
      description: 'woke：目标 live，消息已投递',
      properties: {
        kind: { type: 'string', const: 'woke' },
        reason: { type: 'string', description: '结局说明' },
        data: { type: 'string', description: '投递正文' },
        targets: {
          type: 'array',
          description: '投递目标',
          items: { type: 'string' },
        },
        fallbackFrom: {
          type: 'string',
          description: '自定义 session 不可达时的回退来源',
        },
        detail: { type: 'string', description: '补充细节' },
      },
      required: ['kind', 'reason', 'data', 'targets'],
    },
    {
      type: 'object',
      description: 'queued：目标未 live，消息已入内存 outbox',
      properties: {
        kind: { type: 'string', const: 'queued' },
        reason: { type: 'string', description: '结局说明' },
        targets: {
          type: 'array',
          description: '投递目标',
          items: { type: 'string' },
        },
        fallbackFrom: {
          type: 'string',
          description: '自定义 session 不可达时的回退来源',
        },
        detail: { type: 'string', description: '补充细节' },
      },
      required: ['kind', 'reason', 'targets'],
    },
    {
      type: 'object',
      description: 'skipped：本次触发被跳过（冷却 / 单飞 / 投递跳过）',
      properties: {
        kind: { type: 'string', const: 'skipped' },
        reason: { type: 'string', description: '结局说明' },
        detail: { type: 'string', description: '补充细节' },
      },
      required: ['kind', 'reason'],
    },
    {
      type: 'object',
      description: 'failed：执行 / 投递失败',
      properties: {
        kind: { type: 'string', const: 'failed' },
        reason: { type: 'string', description: '结局说明' },
        detail: { type: 'string', description: '补充细节' },
        failureKind: {
          type: 'string',
          enum: ['missing', 'runtime', 'exec', 'parse', 'deliver'],
          description: '失败分类',
        },
        notified: { type: 'boolean', description: '是否已投递失败通知' },
        consecutiveFailures: { type: 'number', description: '连续失败次数' },
      },
      required: ['kind', 'reason', 'failureKind', 'notified', 'consecutiveFailures'],
    },
    {
      type: 'object',
      description: 'missed：离线队列中的消息过期被丢弃',
      properties: {
        kind: { type: 'string', const: 'missed' },
        reason: { type: 'string', description: '结局说明' },
        detail: { type: 'string', description: '补充细节' },
        scheduledAt: {
          type: 'string',
          description: '消息原定投递时刻（ISO 8601 字符串）',
        },
      },
      required: ['kind', 'reason', 'scheduledAt'],
    },
  ],
}

/**
 * 运行结局 → 工具出参（lossless JSON）。
 *
 * `TaskRunOutcome.missed.scheduledAt` 在内部是 `Date`（且**必填**，与
 * {@link TASK_RUN_OUTPUT_SCHEMA} 的 missed 分支 required 一致）；JSON Schema
 * 没有 Date 类型，dsh-tools 会以「must be a lossless JSON object」拒绝。这里在
 * **输出边界**把它序列化为 ISO 8601 字符串（schema 声明为 string），其余结局
 * 原样返回（保持对象身份，避免无意义的拷贝改变调用方可见行为）。
 *
 * `instanceof Date` 判断在类型层恒真，保留它是为兜底未走类型检查的 JS 调用方：
 * 传进来的若已不是 Date，就不做转换、让它原样落到输出校验（被 schema 拒绝），
 * 而不是把非 Date 值伪造成 ISO 字符串。
 */
function serializeRunOutcome(outcome: TaskRunOutcome): unknown {
  if (outcome.kind !== 'missed' || !(outcome.scheduledAt instanceof Date)) return outcome
  return { ...outcome, scheduledAt: outcome.scheduledAt.toISOString() }
}

const ID_PARAMETER = {
  type: 'string',
  description: '任务唯一标识（字母/数字开头，允许 . _ -，≤128 字符）',
} as const

const NAME_PARAMETER = { type: 'string', description: '人类可读名称' } as const

const CRON_PARAMETER = {
  type: 'string',
  description: 'cron 表达式，**必须 5 段**（分 时 日 月 周），最小粒度分钟；不接受秒字段',
} as const

const ENABLED_PARAMETER = { type: 'boolean', description: '是否启用' } as const

const KIND_PARAMETER = {
  type: 'string',
  enum: ['script', 'text'],
  description:
    '任务类型；create 缺省 script，update 缺省保持原类型。' +
    'script 必须提供 task_path 且不得传 text，text 必须提供 text 且不得传 task_path',
} as const

const TASK_PATH_PARAMETER = {
  type: 'string',
  description:
    '任务程序入口：相对 workspace 的路径或绝对路径，扩展名限 .js / .mjs / .cjs / .ts；' +
    '创建 / 更新时必须指向存在且可读的普通文件',
} as const

const TEXT_PARAMETER = {
  type: 'string',
  description: '投递正文（text 任务必填，允许空串）',
} as const

const SESSION_PARAMETER = {
  type: 'string',
  description: '自定义投递目标 session id（不校验会话是否存在，允许先建任务后建会话）',
} as const

/** 仅当允许自定义 session 时才把 `session_id` 放进 parameters。 */
function sessionProperties(allowCustomSession: boolean): Record<string, unknown> {
  return allowCustomSession ? { session_id: SESSION_PARAMETER } : {}
}

/** 渲染单条任务视图的多行文本。 */
function renderTaskLines(view: TaskView): string {
  const lines = [`${view.enabled ? '🟢' : '⚪'} ${view.id} — ${view.name} [${view.kind}]`, `cron: ${view.cron}`]
  if (view.kind === 'text') {
    lines.push(`text: ${view.text ?? ''}`)
  } else {
    lines.push(`task_path: ${view.task_path ?? ''}`)
  }
  if (view.session_id !== undefined) lines.push(`session_id: ${view.session_id}`)
  for (const warning of view.warnings) lines.push(`⚠️ ${warning}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 8 个工具
// ---------------------------------------------------------------------------

/** `task_create`：新建任务定义（id 必须唯一）。 */
function createTaskCreateTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store, workspace } = options
  const allowScript = options.allowScript ?? true
  const allowCustomSession = options.allowCustomSession ?? false
  return {
    name: 'task_create',
    description:
      '新建一条定时任务定义并立即生效。id 必须唯一（已存在会报错）；cron 只接受 5 段（分 时 日 月 周）。' +
      'kind 缺省 script：script 任务必须提供 task_path（相对 workspace 或绝对路径，文件必须存在且可读），' +
      'text 任务必须提供 text。',
    parameters: {
      type: 'object',
      properties: {
        id: ID_PARAMETER,
        name: NAME_PARAMETER,
        cron: CRON_PARAMETER,
        kind: KIND_PARAMETER,
        task_path: TASK_PATH_PARAMETER,
        text: TEXT_PARAMETER,
        enabled: { ...ENABLED_PARAMETER, description: '是否启用，缺省 true' },
        ...sessionProperties(allowCustomSession),
      },
      required: ['id', 'name', 'cron'],
      additionalProperties: false,
    },
    output: {
      schema: TASK_WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => {
        const view = (value as { task: TaskView }).task
        return [
          {
            type: 'text' as const,
            text: `✅ 已创建任务 ${view.id}（kind=${view.kind}，enabled=${view.enabled}，cron=${view.cron}）`,
          },
        ]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      if (taskFileExists(store, id)) {
        throw new SchedulerToolError(`任务 ${id} 已存在，create 不允许覆盖（请改用 task_update）`)
      }
      const name = validateName(record.name)
      const cron = validateTaskCron(record.cron)
      const kind = record.kind === undefined ? 'script' : validateKind(record.kind)
      const enabled = record.enabled === undefined ? true : validateEnabled(record.enabled)

      let sessionId: string | undefined
      if (record.session_id !== undefined) {
        if (!allowCustomSession) {
          throw new SchedulerToolError(
            '当前配置不允许自定义 session_id（allowCustomSession=false）',
          )
        }
        sessionId = validateSessionId(record.session_id)
      }

      let task: TaskDef
      if (kind === 'script') {
        if (record.text !== undefined) {
          throw new SchedulerToolError('script 任务不得提供 text（kind 交叉约束）')
        }
        if (record.task_path === undefined) {
          throw new SchedulerToolError('script 任务必须提供 task_path')
        }
        if (!allowScript) {
          throw new SchedulerToolError('当前配置不允许创建 / 更新 script 任务（allowScript=false）')
        }
        const taskPath = await validateTaskPath(workspace, record.task_path)
        task = assembleTask({ id, name, cron, enabled, sessionId, kind: 'script', taskPath })
      } else {
        if (record.task_path !== undefined) {
          throw new SchedulerToolError('text 任务不得提供 task_path（kind 交叉约束）')
        }
        if (record.text === undefined) {
          throw new SchedulerToolError('text 任务必须提供 text')
        }
        task = assembleTask({
          id,
          name,
          cron,
          enabled,
          sessionId,
          kind: 'text',
          text: validateTextValue(record.text),
        })
      }

      store.save(task)
      notifyChange(options)
      return { ok: true, task: await toTaskView(workspace, task) }
    },
  }
}

/** `task_list`：列出全部任务定义（+ 可选损坏诊断）。 */
function createTaskListTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store, workspace } = options
  return {
    name: 'task_list',
    description: '列出全部定时任务定义（按 id 升序），包含任务类型与非破坏性警告。只读操作。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: TASK_LIST_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => {
        const result = value as { tasks: TaskView[]; corrupted?: string[] }
        if (result.tasks.length === 0) {
          const extra =
            result.corrupted === undefined || result.corrupted.length === 0
              ? ''
              : `（另有 ${result.corrupted.length} 个损坏文件：${result.corrupted.join(', ')}）`
          return [{ type: 'text' as const, text: `暂无定时任务${extra}` }]
        }
        const lines = result.tasks.map((task) => {
          const target = task.kind === 'text' ? `text(${task.text?.length ?? 0} 字)` : task.task_path ?? ''
          return `${task.enabled ? '🟢' : '⚪'} ${task.id} — ${task.name} [${task.kind}] ${task.cron} → ${target}`
        })
        let text = `共 ${result.tasks.length} 个任务：\n${lines.join('\n')}`
        if (result.corrupted !== undefined && result.corrupted.length > 0) {
          text += `\n损坏文件（已跳过）：${result.corrupted.join(', ')}`
        }
        return [{ type: 'text' as const, text }]
      },
    },
    execute: async (): Promise<unknown> => {
      const { tasks, corrupted } = store.list()
      const views = await Promise.all(tasks.map((task) => toTaskView(workspace, task)))
      return corrupted.length === 0 ? { tasks: views } : { tasks: views, corrupted: [...corrupted] }
    },
  }
}

/** `task_get`：读取单个任务定义。 */
function createTaskGetTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store, workspace } = options
  return {
    name: 'task_get',
    description: '读取单条定时任务定义（含类型与非破坏性警告）；id 不存在时报错。只读操作。',
    parameters: {
      type: 'object',
      properties: { id: ID_PARAMETER },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: TASK_GET_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => {
        const view = (value as { task: TaskView }).task
        return [{ type: 'text' as const, text: renderTaskLines(view) }]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      return { task: await toTaskView(workspace, requireTask(store, id)) }
    },
  }
}

/** `task_update`：更新已有任务定义（不存在即报错，绝不静默创建）。 */
function createTaskUpdateTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store, workspace } = options
  const allowScript = options.allowScript ?? true
  const allowCustomSession = options.allowCustomSession ?? false
  return {
    name: 'task_update',
    description:
      '更新一条已存在的定时任务定义并立即生效。id 必须已存在（不存在会报错，不会新建）；' +
      '未提供的字段保持原值；整文件重写会保留磁盘上已有的 session_id。kind 交叉约束与创建一致。',
    parameters: {
      type: 'object',
      properties: {
        id: ID_PARAMETER,
        name: { type: 'string', description: '新名称（缺省保持原值）' },
        cron: CRON_PARAMETER,
        kind: KIND_PARAMETER,
        task_path: TASK_PATH_PARAMETER,
        text: TEXT_PARAMETER,
        enabled: { type: 'boolean', description: '是否启用（缺省保持原值）' },
        ...sessionProperties(allowCustomSession),
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: TASK_WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => {
        const view = (value as { task: TaskView }).task
        return [
          {
            type: 'text' as const,
            text: `✅ 已更新任务 ${view.id}（kind=${view.kind}，enabled=${view.enabled}，cron=${view.cron}）`,
          },
        ]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      const existing = requireTask(store, id)

      const kind = record.kind === undefined ? kindOf(existing) : validateKind(record.kind)
      const base = carryOver(existing)
      const name = record.name === undefined ? existing.name : validateName(record.name)
      const cron = record.cron === undefined ? existing.cron : validateTaskCron(record.cron)
      const enabled = record.enabled === undefined ? existing.enabled : validateEnabled(record.enabled)

      let sessionId = base.sessionId
      if (record.session_id !== undefined) {
        if (!allowCustomSession) {
          throw new SchedulerToolError(
            '当前配置不允许自定义 session_id（allowCustomSession=false）',
          )
        }
        sessionId = validateSessionId(record.session_id)
      }

      let task: TaskDef
      if (kind === 'script') {
        if (record.text !== undefined) {
          throw new SchedulerToolError('script 任务不得提供 text（kind 交叉约束）')
        }
        if (!allowScript) {
          throw new SchedulerToolError('当前配置不允许创建 / 更新 script 任务（allowScript=false）')
        }
        const explicitPath = record.task_path !== undefined
        const kindChanged = record.kind !== undefined && kind !== kindOf(existing)
        const sourcePath = explicitPath ? (record.task_path as string) : scriptPathOf(existing)
        if (sourcePath === undefined) {
          throw new SchedulerToolError('script 任务必须提供 task_path')
        }
        // 只在「显式提供 task_path」或「kind 变更」时做 L2 强校验。
        // 仅改名 / 改 cron / 改 name 时保留旧路径并通过：程序文件可能暂时缺失
        // （例如等待部署），此时视图 warnings 会提示不可用，改名不应被硬失败。
        const taskPath =
          explicitPath || kindChanged
            ? await validateTaskPath(workspace, sourcePath)
            : sourcePath
        task = assembleTask({
          id,
          name,
          cron,
          enabled,
          sessionId,
          cooldownMs: base.cooldownMs,
          kind: 'script',
          taskPath,
        })
      } else {
        if (record.task_path !== undefined) {
          throw new SchedulerToolError('text 任务不得提供 task_path（kind 交叉约束）')
        }
        const sourceText = record.text === undefined ? textOf(existing) : record.text
        if (sourceText === undefined) {
          throw new SchedulerToolError('text 任务必须提供 text')
        }
        task = assembleTask({
          id,
          name,
          cron,
          enabled,
          sessionId,
          cooldownMs: base.cooldownMs,
          kind: 'text',
          text: validateTextValue(sourceText),
        })
      }

      store.save(task)
      notifyChange(options)
      return { ok: true, task: await toTaskView(workspace, task) }
    },
  }
}

/** `task_delete`：删除任务定义（**不删除**任务程序文件）。 */
function createTaskDeleteTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store } = options
  return {
    name: 'task_delete',
    description:
      '删除一条定时任务定义并立即生效。只移除任务定义（tasks/<id>.json），不删除任务程序文件。' +
      'id 不存在时报错。',
    parameters: {
      type: 'object',
      properties: { id: ID_PARAMETER },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: TASK_DELETE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => {
        const result = value as { id: string }
        return [{ type: 'text' as const, text: `🗑️ 已删除任务定义 ${result.id}（程序文件保留）` }]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      const removed = store.remove(id)
      if (!removed) {
        throw new SchedulerToolError(`任务 ${id} 不存在，无法删除`)
      }
      notifyChange(options)
      return { ok: true, id }
    },
  }
}

/** 构造 enable / disable 两个只改 `enabled` 的工具。 */
function createToggleTool(options: SchedulerToolsOptions, enabled: boolean): ToolDefinition {
  const { store, workspace } = options
  const name = enabled ? 'task_enable' : 'task_disable'
  return {
    name,
    description: enabled
      ? '启用一条定时任务（仅把 enabled 改为 true，不删定义、不改其它字段）并立即生效；id 不存在时报错。'
      : '禁用一条定时任务（仅把 enabled 改为 false，保留定义与其它字段）并立即生效；id 不存在时报错。',
    parameters: {
      type: 'object',
      properties: { id: ID_PARAMETER },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: TASK_WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => {
        const view = (value as { task: TaskView }).task
        return [
          {
            type: 'text' as const,
            text: `${enabled ? '🟢 已启用' : '⚪ 已禁用'}任务 ${view.id}（enabled=${view.enabled}）`,
          },
        ]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      const existing = requireTask(store, id)
      // 只改 enabled：其余字段（含磁盘上的 session_id / cooldown_ms）原样保留。
      const task =
        existing.kind === 'text'
          ? assembleTask({
              id: existing.id,
              name: existing.name,
              cron: existing.cron,
              enabled,
              sessionId: existing.session_id,
              cooldownMs: existing.cooldown_ms,
              kind: 'text',
              text: existing.text,
            })
          : assembleTask({
              id: existing.id,
              name: existing.name,
              cron: existing.cron,
              enabled,
              sessionId: existing.session_id,
              cooldownMs: existing.cooldown_ms,
              kind: 'script',
              taskPath: existing.task_path,
            })
      store.save(task)
      notifyChange(options)
      return { ok: true, task: await toTaskView(workspace, task) }
    },
  }
}

/** `task_run_now`：立即执行一次任务（不等待定时器）。 */
function createTaskRunNowTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store } = options
  return {
    name: 'task_run_now',
    description:
      '立即执行一次指定任务并返回运行结局（quiet / woke / queued / skipped / failed / missed）。' +
      '任务必须已存在；该操作不影响 cron 计时，也不会修改任务定义。',
    parameters: {
      type: 'object',
      properties: { id: ID_PARAMETER },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: TASK_RUN_OUTPUT_SCHEMA,
      render: (args: unknown, value: unknown) => {
        const outcome = value as TaskRunOutcome
        const id = (args as { id?: string }).id ?? '<unknown>'
        return [
          {
            type: 'text' as const,
            text: `▶️ 任务 ${id} 执行结局：${outcome.kind} — ${outcome.reason}`,
          },
        ]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      requireTask(store, id)
      if (options.runNow === undefined) {
        throw new SchedulerToolError(`当前环境未提供立即执行能力（runNow 未注入），无法运行任务 ${id}`)
      }
      return serializeRunOutcome(await options.runNow(id))
    },
  }
}

/**
 * 构造 8 个任务工具（顺序即语义顺序）。
 *
 * @param options store / workspace / 开关 / onChange / runNow 注入。
 */
export function createSchedulerTools(options: SchedulerToolsOptions): ToolDefinition[] {
  return [
    createTaskCreateTool(options),
    createTaskListTool(options),
    createTaskGetTool(options),
    createTaskUpdateTool(options),
    createTaskDeleteTool(options),
    createToggleTool(options, true),
    createToggleTool(options, false),
    createTaskRunNowTool(options),
  ]
}
