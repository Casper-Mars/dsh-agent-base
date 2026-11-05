/**
 * 插件运行期状态（包内部）。
 *
 * `apply` 在解析完成后把状态挂到 `ctx` 上（WeakMap key 为 ctx），供后续
 * 任务发布 `ctx.agentBase` service 时读取。本模块不从包入口导出，属于内部
 * 实现细节；使用 WeakMap 保证插件卸载后不残留引用。
 */
import type { Workspace } from '@deepseek-ai/dsh-workspace'

/** `apply` 完成后保存的启动状态。 */
export interface AgentBaseState {
  /** 已注册的固定 Workspace 实体。 */
  readonly workspace: Workspace
  /** 固定工作区的 canonical 绝对路径，等价于 `workspace.path`。 */
  readonly workspaceCwd: string
  /** 后台投递默认使用的 session id。 */
  readonly mainSessionId: string
}

const states = new WeakMap<object, AgentBaseState>()

/** 保存状态；同一 owner 重复调用时覆盖（HMR 重载语义）。 */
export function setAgentBaseState(owner: object, state: AgentBaseState): void {
  states.set(owner, state)
}

/** 读取状态；未初始化时返回 `undefined`。 */
export function getAgentBaseState(owner: object): AgentBaseState | undefined {
  return states.get(owner)
}
