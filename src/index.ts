/**
 * `dsh-agent-base` 包入口：Cordis 插件三要素 + 配置 schema。
 *
 * 定位：固定工作区 cwd 与 main session id 的**权威来源**，不是投递总线。
 * 本任务（Task-01）只建立可编译、可安装的骨架，`apply` 保持空实现；
 * workspace 解析、`ctx.agentBase` 服务发布与 main session 校验在后续任务补入。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** 插件唯一标识，必须与 `cordis.patch.yml` 中 row 的 `id`/`name` 对应。 */
export const name = 'agent-base'

/**
 * 依赖服务（契约固定）：
 *   - `workspaceRegistry`   —— 工作区注册表
 *   - `sessionPersistence`  —— 会话持久化（校验已有 main session 的 cwd）
 *   - `agents`              —— agent 注册表（后续由消费方使用，base 自身不创建）
 *
 * 必须与 `cordis.patch.yml` 中对应条目的 `inject` 逐项一致。
 */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'agents']

/** 插件配置（见技术方案 §3.2）。 */
export interface Config {
  /** 固定工作区的绝对路径。 */
  workspace: string
  /** 后台投递默认使用的稳定 session id。 */
  mainSessionId: string
  /** 目录不存在时是否创建，默认 `true`。 */
  createWorkspaceDir?: boolean
  /** 启动时校验同 id 的持久化 session 的 cwd 是否与固定工作区一致，默认 `true`。 */
  validateExistingMain?: boolean
}

/**
 * 配置 schema。由 dsh loader 在装配前读取并校验，因此必须作为具名导出提供，
 * 且 schemastery 放在 `dependencies`（运行时需要）。
 */
export const Config: z<Config> = z.object({
  workspace: z.string().required(),
  mainSessionId: z.string().pattern(/^[A-Za-z0-9._-]{1,64}$/).required(),
  createWorkspaceDir: z.boolean().default(true),
  validateExistingMain: z.boolean().default(true),
})

/**
 * 插件装配入口。
 *
 * Task-01 不实现任何业务逻辑：不 mkdir、不访问 workspaceRegistry、不创建
 * main session、不发布服务。后续任务在此补入「解析 workspace → 校验 main
 * session → 发布 ctx.agentBase」的启动序列。
 */
export function apply(ctx: Context, config: Config): void {
  void ctx
  void config
}
