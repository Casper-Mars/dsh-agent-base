/**
 * `dsh-agent-base` 包入口：Cordis 插件三要素 + `apply`。
 *
 * 定位：固定工作区 cwd 与 main session id 的**权威来源**，不是投递总线。
 *
 * `apply` 负责依赖注入、错误转换与发布只读服务：
 *   1. `resolveFixedWorkspace` 解析并注册固定 workspace（纯函数，可单测）；
 *   2. `validateExistingMain` 校验已存在的 main session 的 cwd 是否与之一致
 *      （只读守卫：不创建、不恢复、不 attachSession、不改 header）；
 *   3. 两步都成功后实例化 {@link AgentBaseService}，由 Cordis fiber 管理生命周期。
 *
 * 顺序固定为「resolve → validate → service」，校验失败时不会留下已注册的服务。
 *
 * 仍然不做：创建/恢复 main session、任何投递能力。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// 仅为了加载官方包的 Context 模块增强（`ctx.agents` / `ctx.sessionPersistence`）。
// 这两个服务在这里**只被读取**，base 不使用它们的任何写能力。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { AgentBaseService } from './service.js'
import { AgentBaseConfigError, resolveFixedWorkspace } from './workspace.js'
import { AgentBaseError } from './errors.js'
import { validateExistingMain } from './validate.js'
import type { Config } from './config.js'

/** 插件唯一标识，必须与 `cordis.patch.yml` 中 row 的 `id`/`name` 对应。 */
export const name = 'agent-base'

/**
 * 依赖服务（契约固定）：
 *   - `workspaceRegistry`   —— 工作区注册表
 *   - `sessionPersistence`  —— 会话持久化（校验已有 main session 的 cwd）
 *   - `agents`              —— agent 注册表（校验时只读 `get`，base 自身不创建）
 *
 * 必须与 `cordis.patch.yml` 中对应条目的 `inject` 逐项一致。
 */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'agents']

// `export { Config }` 同时携带 const 与 interface 两个含义（声明合并），
// 消费方可 `import { Config }`（schema）或 `import type { Config }`（类型）。
export { Config } from './config.js'
export { AgentBaseService } from './service.js'
export type { AgentBaseOptions } from './service.js'
export { AgentBaseConfigError, resolveFixedWorkspace } from './workspace.js'
export type {
  FixedWorkspaceFs,
  FixedWorkspaceRegistry,
  ResolveFixedWorkspaceConfig,
  ResolveFixedWorkspaceDeps,
} from './workspace.js'
export {
  AgentBaseError,
  AgentBaseValidationError,
  AgentBaseWorkspaceMismatchError,
} from './errors.js'
export { validateExistingMain } from './validate.js'
export type { ValidateExistingMainDeps, ValidateExistingMainOptions } from './validate.js'

/**
 * 插件装配入口。
 *
 * 启动序列：校验绝对路径 → `mkdir -p`（可选）→ `realpath` → `workspaceRegistry.create(canonical)`
 * → 校验已存在的 main session cwd → 发布只读 `ctx.agentBase` service。
 *
 * {@link AgentBaseError} 的子类（配置错误 / cwd 不一致 / 校验失败）原样抛出，
 * 保留结构化字段与 `cause`；只有真正未知的错误才包装为 {@link AgentBaseConfigError}。
 * 绝不静默回退到 cwd / registry 首项 / 某个 session 的 cwd，也绝不改投 session。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  try {
    const workspace = await resolveFixedWorkspace(config, { registry: ctx.workspaceRegistry })
    await validateExistingMain(
      {
        mainSessionId: config.mainSessionId as SessionId,
        workspaceCwd: workspace.path,
        validateExistingMain: config.validateExistingMain,
      },
      { agents: ctx.agents, sessionPersistence: ctx.sessionPersistence },
    )
    new AgentBaseService(ctx, {
      workspaceCwd: workspace.path,
      mainSessionId: config.mainSessionId as SessionId,
    })
  } catch (error) {
    if (error instanceof AgentBaseError) throw error
    throw new AgentBaseConfigError(
      `agent-base: failed to prepare fixed workspace '${config.workspace}': ${String(error)}`,
      config.workspace,
      { cause: error },
    )
  }
}
