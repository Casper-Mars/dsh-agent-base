/**
 * `dsh-agent-base` 包入口：Cordis 插件三要素 + `apply`。
 *
 * 定位：固定工作区 cwd 与 main session id 的**权威来源**，不是投递总线。
 *
 * 本版本（任务-02）只做「解析固定 workspace 并注册」：`apply` 负责依赖注入、
 * 状态保存与错误转换，真正的解析逻辑在 `resolveFixedWorkspace`（纯函数，可单测）。
 * 仍然不做：发布 `ctx.agentBase` service（任务-03）、创建/恢复 main session、
 * `validateExistingMain` 校验。
 */
import type { Context } from '@deepseek-ai/cordis'
import { setAgentBaseState } from './state.js'
import { AgentBaseConfigError, resolveFixedWorkspace } from './workspace.js'
import type { Config } from './config.js'

/** 插件唯一标识，必须与 `cordis.patch.yml` 中 row 的 `id`/`name` 对应。 */
export const name = 'agent-base'

/**
 * 依赖服务（契约固定）：
 *   - `workspaceRegistry`   —— 工作区注册表
 *   - `sessionPersistence`  —— 会话持久化（后续校验已有 main session 的 cwd）
 *   - `agents`              —— agent 注册表（后续由消费方使用，base 自身不创建）
 *
 * 必须与 `cordis.patch.yml` 中对应条目的 `inject` 逐项一致。
 */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'agents']

// `export { Config }` 同时携带 const 与 interface 两个含义（声明合并），
// 消费方可 `import { Config }`（schema）或 `import type { Config }`（类型）。
export { Config } from './config.js'
export { AgentBaseConfigError, resolveFixedWorkspace } from './workspace.js'
export type {
  FixedWorkspaceFs,
  FixedWorkspaceRegistry,
  ResolveFixedWorkspaceConfig,
  ResolveFixedWorkspaceDeps,
} from './workspace.js'

/**
 * 插件装配入口。
 *
 * 启动序列：校验绝对路径 → `mkdir -p`（可选）→ `realpath` → `workspaceRegistry.create(canonical)`。
 * 成功后把 `{ workspace, workspaceCwd, mainSessionId }` 存入包内状态（WeakMap，key 为 ctx），
 * 供后续任务的 `ctx.agentBase` service 读取。
 *
 * 任何失败都转换为 {@link AgentBaseConfigError}，保证错误信息保留配置中的原值；
 * 绝不静默回退到 cwd / registry 首项 / 某个 session 的 cwd。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  try {
    const workspace = await resolveFixedWorkspace(config, { registry: ctx.workspaceRegistry })
    setAgentBaseState(ctx, {
      workspace,
      workspaceCwd: workspace.path,
      mainSessionId: config.mainSessionId,
    })
  } catch (error) {
    if (error instanceof AgentBaseConfigError) throw error
    throw new AgentBaseConfigError(
      `agent-base: failed to prepare fixed workspace '${config.workspace}': ${String(error)}`,
      config.workspace,
      { cause: error },
    )
  }
}
