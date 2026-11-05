/**
 * `ctx.agentBase`：只读身份与路径服务。
 *
 * 本服务只暴露两个稳定只读属性：
 *   - `workspaceCwd`  —— canonical 绝对路径（任务-02 的解析结果）；
 *   - `mainSessionId` —— 后台投递默认使用的稳定 session id（来自配置）。
 *
 * 明确**不提供**投递与生命周期能力：
 *   - 没有 `ensure` / `deliver` / `bind` / `status`；
 *   - 不创建或恢复 Agent，不调用 `workspace.attachSession`；
 *   - 不读取 `process.cwd()`。
 *
 * 实例由 Cordis `Service` 在构造时注册到 owner fiber，fiber 卸载时自动注销。
 * 两个值在构造时通过 `Object.defineProperty` 定义为不可写、不可重配置，
 * 构造后不可变。
 *
 * 注：Cordis 会把服务实例包在用于追踪的 Proxy 中（getter 的 `this` 会被
 * 替换为 shadow 对象），ECMAScript `#` 私有字段在 Proxy 下不可访问，因此这里
 * 使用不可写的数据属性而不是 `#` 字段 / getter。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** `AgentBaseService` 的构造参数。 */
export interface AgentBaseOptions {
  /** canonical 绝对路径（realpath 后）。 */
  readonly workspaceCwd: string
  /** 后台投递默认使用的 session id。 */
  readonly mainSessionId: SessionId
}

/** 只读的 agent base 服务。 */
export class AgentBaseService extends Service {
  /** 固定工作区的 canonical 绝对路径（构造后不可写）。 */
  readonly workspaceCwd!: string

  /** 后台投递默认使用的稳定 session id（构造后不可写）。 */
  readonly mainSessionId!: SessionId

  constructor(ctx: Context, options: AgentBaseOptions) {
    super(ctx, 'agentBase')
    Object.defineProperty(this, 'workspaceCwd', {
      value: options.workspaceCwd,
      enumerable: true,
      writable: false,
      configurable: false,
    })
    Object.defineProperty(this, 'mainSessionId', {
      value: options.mainSessionId,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentBase: AgentBaseService
  }
}
