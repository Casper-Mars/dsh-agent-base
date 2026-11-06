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

/** 调度子系统的配置（见技术方案 §5.1 / §5.2）。 */
export interface SchedulerConfig {
  /** 是否启用定时调度；`false` 时不注册工具、不创建 timer、不发布服务。 */
  enabled: boolean
  /** cron 计算使用的 IANA 时区；缺省取进程系统时区，取不到时回落 `UTC`。 */
  timezone: string
  /** 任务定义目录，相对 workspace；绝对路径会被拒绝并降级为默认目录。 */
  tasksDir: string
  /** 是否允许创建 / 执行 script 任务。 */
  allowScript: boolean
  /** 是否允许在工具入参中自定义 `session_id`（仅影响工具 schema 与写入）。 */
  allowCustomSession: boolean
  /** 脚本任务执行超时（毫秒）。 */
  scriptTimeoutMs: number
  /** 脚本任务 stdout / stderr 单路上限（字节）。 */
  maxOutputBytes: number
  /** 投递正文预算（字素）。 */
  maxDeliverChars: number
  /** 目标非 live 时的行为：入内存 outbox 或直接跳过。 */
  deliverOnOffline: 'queue' | 'skip'
  /** 离线 outbox 条目 TTL（毫秒）。 */
  pendingTtlMs: number
  /** 每任务离线队列合计上限。 */
  maxPendingPerTask: number
}

/** 解析系统时区；不可用时回落 `UTC`。 */
export function resolveSystemTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone.trim() !== '' ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 调度配置默认值（所有字段均有默认值）。 */
export const DEFAULT_SCHEDULER_CONFIG: Readonly<SchedulerConfig> = Object.freeze({
  enabled: true,
  timezone: resolveSystemTimezone(),
  tasksDir: '.agent-base/tasks',
  allowScript: true,
  allowCustomSession: false,
  scriptTimeoutMs: 60_000,
  maxOutputBytes: 1_048_576,
  maxDeliverChars: 4_000,
  deliverOnOffline: 'queue',
  pendingTtlMs: 600_000,
  maxPendingPerTask: 20,
})

/**
 * 用默认值补齐调度配置。
 *
 * `apply` 直接调用它，因此即使调用方绕过 dsh loader / schema（例如单测直接
 * 构造配置）也能得到与 `Config` schema 完全一致的默认值。
 */
export function resolveSchedulerConfig(
  input?: Partial<SchedulerConfig>,
): SchedulerConfig {
  const defaults = DEFAULT_SCHEDULER_CONFIG
  return {
    enabled: input?.enabled ?? defaults.enabled,
    timezone: input?.timezone ?? defaults.timezone,
    tasksDir: input?.tasksDir ?? defaults.tasksDir,
    allowScript: input?.allowScript ?? defaults.allowScript,
    allowCustomSession: input?.allowCustomSession ?? defaults.allowCustomSession,
    scriptTimeoutMs: input?.scriptTimeoutMs ?? defaults.scriptTimeoutMs,
    maxOutputBytes: input?.maxOutputBytes ?? defaults.maxOutputBytes,
    maxDeliverChars: input?.maxDeliverChars ?? defaults.maxDeliverChars,
    deliverOnOffline: input?.deliverOnOffline ?? defaults.deliverOnOffline,
    pendingTtlMs: input?.pendingTtlMs ?? defaults.pendingTtlMs,
    maxPendingPerTask: input?.maxPendingPerTask ?? defaults.maxPendingPerTask,
  }
}

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
  /** 定时调度子配置；缺省使用 {@link DEFAULT_SCHEDULER_CONFIG}。 */
  scheduler?: SchedulerConfig
}

/** 调度配置 schema（所有字段都有默认值）。 */
const SchedulerConfigSchema: z<SchedulerConfig> = z.object({
  enabled: z.boolean().default(true),
  timezone: z.string().default(resolveSystemTimezone()),
  tasksDir: z.string().default('.agent-base/tasks'),
  allowScript: z.boolean().default(true),
  allowCustomSession: z.boolean().default(false),
  scriptTimeoutMs: z.number().min(1).default(60_000),
  maxOutputBytes: z.number().min(1).default(1_048_576),
  maxDeliverChars: z.number().min(1).default(4_000),
  deliverOnOffline: z.union([z.const('queue'), z.const('skip')]).default('queue'),
  pendingTtlMs: z.number().min(1).default(600_000),
  maxPendingPerTask: z.number().min(1).default(20),
})

/**
 * 配置 schema。由 dsh loader 在装配前读取并校验，因此必须作为具名导出提供，
 * 且 schemastery 放在 `dependencies`（运行时需要）。
 */
export const Config: z<Config> = z.object({
  workspace: z.string().required(),
  mainSessionId: z.string().min(1).pattern(/^[A-Za-z0-9._-]{1,64}$/).required(),
  createWorkspaceDir: z.boolean().default(true),
  validateExistingMain: z.boolean().default(true),
  // 子对象整体缺省 / 整体替换时都补齐默认值（依赖 schemastery 的字段级 default）。
  scheduler: SchedulerConfigSchema.default({ ...DEFAULT_SCHEDULER_CONFIG }),
})
