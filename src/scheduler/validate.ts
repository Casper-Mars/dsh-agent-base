/**
 * 任务程序校验（技术方案 D9：**创建期强校验 + 触发期兜底**）。
 *
 * 两层，职责严格分离：
 *
 *   - **L1 形态**（{@link validateScriptShape}）：纯字符串检查——非空、无 NUL /
 *     控制字符、扩展名在白名单。它不碰文件系统，因此可以在 `tasks.create` /
 *     `tasks.update` 里同步执行，把明显写错的路径挡在落盘之前。
 *   - **L2 存在性 / 可读性**（{@link validateScriptFile}）：`stat` 存在 +
 *     普通文件 + `R_OK` 可读。它需要 I/O，创建期和触发期都调用。
 *
 * 刻意**不做**的事：
 *   - 不做语法解析——`.ts` / `.mjs` 的语法由 Node 自己判定，提前解析会引入
 *     与真实运行时不一致的第二套语义（还会把合法 ESM / TS 误杀）；
 *   - 不启动子进程——那属于 runner；
 *   - 不限制目录归属——绝对路径是显式授权，相对路径按 workspace 解析。
 *
 * 失败一律抛 {@link TaskPathError}，并携带 `failureKind`：
 *   - 扩展名 / 运行时问题 → `'runtime'`；
 *   - 文件缺失 / 非普通文件 / 不可读 → `'missing'`。
 *
 * 错误信息必须包含**解析后的绝对路径**与具体原因（not found / not a file /
 * not readable），这样失败通知与日志里能直接定位到文件。
 */
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import type { TaskFailureKind } from './types.js'

/** v1 支持的任务程序扩展名（全部由 Node 执行）。 */
export const ALLOWED_SCRIPT_EXTENSIONS: readonly string[] = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
])

/** 路径校验的失败分类（`runtime` = 形态 / 运行时；`missing` = 文件不可用）。 */
export type TaskPathFailureKind = Extract<TaskFailureKind, 'runtime' | 'missing'>

/** NUL 与所有 C0 控制字符 + DEL。路径里出现它们只可能是构造错误。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

/**
 * 任务程序路径错误。
 *
 * `path` 是**解析后的绝对路径**（L1 在解析前失败时为 `undefined`）；
 * `reason` 是不带前缀的可读原因，方便调用方直接拼进通知文案。
 */
export class TaskPathError extends Error {
  /** 失败分类：形态 / 运行时问题 vs 文件不可用。 */
  readonly failureKind: TaskPathFailureKind

  /** 解析后的绝对路径（若已解析）。 */
  readonly path: string | undefined

  /** 具体原因（含绝对路径与 not found / not a file / not readable）。 */
  readonly reason: string

  constructor(
    reason: string,
    failureKind: TaskPathFailureKind,
    options: { path?: string; cause?: unknown } = {},
  ) {
    super(
      `[scheduler/validate] ${reason}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'TaskPathError'
    this.failureKind = failureKind
    this.reason = reason
    if (options.path !== undefined) this.path = options.path
  }
}

/**
 * 解析任务程序路径（不要求存在）。
 *
 * - 绝对路径原样返回（只做 `resolve` 归一，去除 `.` / 重复分隔符）；
 * - 相对路径按 `workspace` 解析。
 *
 * 故意**不做** workspace 逃逸检查：`task_path` 允许绝对路径，逃逸限制没有
 * 实际意义；路径归属由调用方的配置语义决定，这里只负责得到绝对路径。
 */
export function resolveScriptPath(workspace: string, taskPath: string): string {
  return isAbsolute(taskPath) ? resolve(taskPath) : resolve(workspace, taskPath)
}

/**
 * L1：任务程序路径的**形态**校验（纯字符串，不碰文件系统）。
 *
 * 通过时返回归一化的小写扩展名（`.js` / `.mjs` / `.cjs` / `.ts`）。
 * 失败抛 {@link TaskPathError}，`failureKind = 'runtime'`。
 */
export function validateScriptShape(taskPath: string): string {
  if (typeof taskPath !== 'string') {
    throw new TaskPathError(
      `任务程序路径必须是字符串，实际为 ${typeof taskPath}`,
      'runtime',
    )
  }
  if (taskPath.trim() === '') {
    throw new TaskPathError('任务程序路径不能为空', 'runtime')
  }
  if (CONTROL_CHARS.test(taskPath)) {
    throw new TaskPathError(
      `任务程序路径不得包含 NUL / 控制字符：${JSON.stringify(taskPath)}`,
      'runtime',
    )
  }
  const extension = extname(taskPath).toLowerCase()
  if (extension === '') {
    throw new TaskPathError(
      `任务程序路径缺少扩展名（要求 ${ALLOWED_SCRIPT_EXTENSIONS.join(' / ')}）：${JSON.stringify(taskPath)}`,
      'runtime',
    )
  }
  if (!ALLOWED_SCRIPT_EXTENSIONS.includes(extension)) {
    throw new TaskPathError(
      `任务程序扩展名不受支持：${extension}（要求 ${ALLOWED_SCRIPT_EXTENSIONS.join(' / ')}）`,
      'runtime',
    )
  }
  return extension
}

/** 文件系统窄接口（测试可注入 fake，默认 `node:fs/promises`）。 */
export interface ScriptFileFs {
  /** `stat`；存在性由异常表达。 */
  stat(path: string): Promise<{ isFile(): boolean }>
  /** 权限探测；不可读由异常表达。 */
  access(path: string, mode: number): Promise<void>
}

/** {@link validateScriptFile} / {@link validateScript} 的可注入依赖。 */
export interface ScriptValidationDeps {
  /** 文件系统；默认 `node:fs/promises` 的 `stat` / `access`。 */
  readonly fs?: ScriptFileFs
}

const defaultFs: ScriptFileFs = {
  stat: (path) => stat(path),
  access: async (path, mode) => {
    await access(path, mode)
  },
}

/** 把未知异常渲染成带错误码的诊断文本（ENOENT → not found）。 */
function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && code !== '') {
    return code === 'ENOENT' ? 'not found' : code
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * L2：文件**存在性 + 普通文件 + 可读性**校验。
 *
 * 失败抛 {@link TaskPathError}，`failureKind = 'missing'`；信息里带绝对路径
 * 与具体原因。顺序固定：先 `stat`（区分不存在 / 非普通文件），再 `access`。
 */
export async function validateScriptFile(
  absPath: string,
  deps: ScriptValidationDeps = {},
): Promise<void> {
  const fs = deps.fs ?? defaultFs

  let stats: { isFile(): boolean }
  try {
    stats = await fs.stat(absPath)
  } catch (error) {
    const detail = describeFsError(error)
    const reason =
      detail === 'not found'
        ? `任务程序不存在（not found）：${absPath}`
        : `任务程序无法访问（${detail}）：${absPath}`
    throw new TaskPathError(reason, 'missing', { path: absPath, cause: error })
  }

  if (!stats.isFile()) {
    throw new TaskPathError(`任务程序不是普通文件（not a file）：${absPath}`, 'missing', {
      path: absPath,
    })
  }

  try {
    await fs.access(absPath, constants.R_OK)
  } catch (error) {
    throw new TaskPathError(`任务程序不可读（not readable）：${absPath}`, 'missing', {
      path: absPath,
      cause: error,
    })
  }
}

/** 校验通过后的结果。 */
export interface ScriptValidationResult {
  /** 解析后的绝对路径。 */
  readonly path: string
  /** 归一化的小写扩展名。 */
  readonly extension: string
  /** 执行运行时（v1 恒为 `node`）。 */
  readonly runtime: 'node'
}

/**
 * 组合入口：L1 形态 → 解析绝对路径 → L2 存在性 / 可读性。
 *
 * 返回 `{ path, extension, runtime: 'node' }`，供 runner 直接使用。
 * 任一层失败都抛 {@link TaskPathError}（`failureKind` 已有区分）。
 */
export async function validateScript(
  workspace: string,
  taskPath: string,
  deps: ScriptValidationDeps = {},
): Promise<ScriptValidationResult> {
  const extension = validateScriptShape(taskPath)
  const path = resolveScriptPath(workspace, taskPath)
  await validateScriptFile(path, deps)
  return { path, extension, runtime: 'node' }
}
