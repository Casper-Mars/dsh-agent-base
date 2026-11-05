/**
 * 启动期的 main session 校验：已存在则其 cwd 必须等于固定 workspace。
 *
 * 定位：**只读的守卫**。它回答一个问题——「如果 main session 已经存在，
 * 它是不是在正确的目录里？」它绝不修复、绝不改投：
 *
 *   - 不调用 `agents.create` / `agents.resume`；
 *   - 不调用 `workspace.attachSession`；
 *   - 不修改 session header（不改 cwd、不改绑 workspace）；
 *   - session 不存在时直接通过，**不**顺手创建一个。
 *
 * 校验顺序（与方案 §3.3 一致）：
 *   1. `validateExistingMain === false` → 整个校验跳过，连 `agents.get` 都不调用；
 *   2. `ctx.agents.get(mainSessionId)` 命中（live session）→ 读 header.cwd 比较，命中后
 *      **不再**查持久化（live 是更新的事实来源）；
 *   3. 未命中 → `sessionPersistence.stat(mainSessionId)`；`undefined` 表示没有该 session → 通过；
 *   4. stat 抛错 → @see AgentBaseValidationError（保留 cause）。
 *
 * cwd 比较是 canonical 比较：字符串相等直接通过，否则对实际值做 `realpath` 后再比；
 * `realpath` 失败视为不匹配（路径已不存在，无法证明它是同一个目录）。
 */
import { realpath } from 'node:fs/promises'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AgentBaseValidationError, AgentBaseWorkspaceMismatchError } from './errors.js'

/** `validateExistingMain` 的输入。 */
export interface ValidateExistingMainOptions {
  /** 待校验的 main session id（来自配置）。 */
  readonly mainSessionId: SessionId
  /** 固定 workspace 的 canonical 路径；比较的期望值。 */
  readonly workspaceCwd: string
  /** 默认 `true`；显式 `false` 时整个校验跳过。 */
  readonly validateExistingMain?: boolean
}

/**
 * live Agent 的窄结构视图。
 *
 * `ctx.agents.get(id)` 的公开类型 `Agent` 只暴露 `id`，但真实实现
 * （`dsh-agent-loop` 的 `ReactLoopAgent`）带有 `session`，`Session.header.cwd`
 * 才是创建时的目录。这里用最小结构类型 + 独立读取，避免依赖官方类型的
 * 未公开细节，也避免改动官方类型。
 */
interface LiveAgentView {
  readonly session?: {
    readonly header?: {
      readonly cwd?: string
    }
  }
}

/** `validateExistingMain` 的依赖。 */
export interface ValidateExistingMainDeps {
  /** agent 注册表；只允许 `get`。 */
  readonly agents: { get(id: SessionId): unknown }
  /** 会话持久化；只允许 `stat`。 */
  readonly sessionPersistence: {
    stat(id: SessionId): Promise<{ header?: { cwd?: string } } | undefined>
  }
  /** 测试注入；默认 `node:fs/promises` 的 `realpath`。 */
  readonly fs?: { realpath(path: string): Promise<string> }
}

const defaultFs: NonNullable<ValidateExistingMainDeps['fs']> = {
  realpath: target => realpath(target),
}

/** 读取 live Agent 的 header.cwd；结构不符时返回 `undefined`。 */
function readLiveCwd(live: unknown): string | undefined {
  const view = live as LiveAgentView | undefined
  return view?.session?.header?.cwd
}

/**
 * canonical 比较：相等即通过，否则用 realpath 归一后比较；无法归一视为不匹配。
 */
async function canonicalEquals(
  actual: string | undefined,
  expected: string,
  fs: NonNullable<ValidateExistingMainDeps['fs']>,
): Promise<boolean> {
  if (actual === undefined) return false
  if (actual === expected) return true
  try {
    return (await fs.realpath(actual)) === expected
  } catch {
    return false
  }
}

/**
 * 校验已存在的 main session 的 cwd，与固定 workspace 保持一致。
 *
 * 通过（resolve）表示「可以继续启动」；失败（reject）有两种：
 *   - {@link AgentBaseWorkspaceMismatchError} —— 有 session，但 cwd 不对；
 *   - {@link AgentBaseValidationError}       —— 读不到 session 事实。
 *
 * @param options - session id、期望 cwd 与总开关。
 * @param deps - agent 注册表、会话持久化与（可选的）文件系统。
 */
export async function validateExistingMain(
  options: ValidateExistingMainOptions,
  deps: ValidateExistingMainDeps,
): Promise<void> {
  if (options.validateExistingMain === false) return

  const { mainSessionId, workspaceCwd } = options
  const fs = deps.fs ?? defaultFs

  const live = deps.agents.get(mainSessionId)
  if (live !== undefined && live !== null) {
    const actual = readLiveCwd(live)
    if (!(await canonicalEquals(actual, workspaceCwd, fs))) {
      throw new AgentBaseWorkspaceMismatchError(mainSessionId, workspaceCwd, actual)
    }
    return
  }

  let snapshot: { header?: { cwd?: string } } | undefined
  try {
    snapshot = await deps.sessionPersistence.stat(mainSessionId)
  } catch (error) {
    throw new AgentBaseValidationError(
      `agent-base: failed to inspect persisted main session '${mainSessionId}'`,
      mainSessionId,
      { cause: error },
    )
  }

  if (snapshot === undefined) return

  const actual = snapshot.header?.cwd
  if (!(await canonicalEquals(actual, workspaceCwd, fs))) {
    throw new AgentBaseWorkspaceMismatchError(mainSessionId, workspaceCwd, actual)
  }
}
