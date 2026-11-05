/**
 * `dsh-agent-base` 的错误模型。
 *
 * 启动期的所有失败共享一个基类 {@link AgentBaseError}，便于 `apply` 区分
 * 「已经是本插件的结构化错误」与「需要包装的未知错误」：
 *
 *   - {@link AgentBaseConfigError}         —— 固定 workspace 配置/目录准备失败；
 *   - {@link AgentBaseWorkspaceMismatchError} —— 已有 main session 的 cwd 与固定 workspace 不一致；
 *   - {@link AgentBaseValidationError}     —— 校验过程本身无法完成（例如 stat 抛错）。
 *
 * 错误只携带 session id 与路径等结构化字段，绝不包含会话内容。
 */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 所有 agent-base 启动错误的基类。 */
export class AgentBaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
  }
}

/** 把可能缺失的值渲染成错误信息里的字面量。 */
const renderCwd = (cwd: string | undefined): string => (cwd === undefined ? '<none>' : `'${cwd}'`)

/**
 * main session 的 cwd 与固定 workspace 不一致。
 *
 * `message` 同时包含期望路径与实际路径，`actualCwd` 在 header 无 cwd 时为
 * `undefined`，此时 message 中以 `<none>` 表示「没有 cwd 可比」。
 */
export class AgentBaseWorkspaceMismatchError extends AgentBaseError {
  /** 校验失败的 main session id。 */
  readonly mainSessionId: SessionId

  /** 固定 workspace 的 canonical 路径。 */
  readonly expectedCwd: string

  /** session header 中的 cwd 原值（可能缺失）。 */
  readonly actualCwd: string | undefined

  constructor(
    mainSessionId: SessionId,
    expectedCwd: string,
    actualCwd: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(
      `agent-base: main session '${mainSessionId}' has cwd ${renderCwd(actualCwd)},`
        + ` expected ${renderCwd(expectedCwd)}; refusing to start`,
      options,
    )
    this.mainSessionId = mainSessionId
    this.expectedCwd = expectedCwd
    this.actualCwd = actualCwd
  }
}

/**
 * 无法完成 main session 校验（例如 `sessionPersistence.stat` 抛错）。
 *
 * 与 Mismatch 区分：这里失败的是「读不到事实」，而不是「事实不对」。
 * `cause` 保留原始错误，避免丢失底层诊断信息。
 */
export class AgentBaseValidationError extends AgentBaseError {
  /** 校验失败的 main session id。 */
  readonly mainSessionId: SessionId

  constructor(message: string, mainSessionId: SessionId, options?: { cause?: unknown }) {
    super(message, options)
    this.mainSessionId = mainSessionId
  }
}
