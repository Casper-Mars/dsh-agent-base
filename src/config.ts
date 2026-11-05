/**
 * `dsh-agent-base` 的配置契约与 schema。
 *
 * 从 `index.ts` 拆出，避免入口文件同时承担「插件三要素」与「配置解析」两件事。
 *
 * 注意：`workspace` 的「非空 + 绝对路径」校验放在 `resolveFixedWorkspace` 里，
 * 因为错误信息必须包含用户写入的原值；若在 schema 层用 `.min(1)`，空串会被
 * schema 先行拦截，丢失带原值的上下文。此处只要求它是字符串且必填。
 */
import z from '@deepseek-ai/schemastery'

/** 插件配置（见技术方案 §3.2）。 */
export interface Config {
  /** 固定工作区的绝对路径；唯一来源，禁止从 cwd / registry / session 推断。 */
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
  mainSessionId: z.string().min(1).pattern(/^[A-Za-z0-9._-]{1,64}$/).required(),
  createWorkspaceDir: z.boolean().default(true),
  validateExistingMain: z.boolean().default(true),
})
