/**
 * 调度子系统装配（技术方案 §5.5 / §5.7 / §9.7）。
 *
 * 由插件 `apply` 在固定 workspace 就绪后调用。装配全程 **不抛异常**：任何
 * 失败都只 `warn` 并把定时能力降级，绝不让调度问题阻断插件启动。
 *
 * 顺序：
 *   resolve tasksDir → TaskStore / StateStore → DeliveryPort → SchedulerService
 *   → 注册 8 个 `task_*` 工具 → `scheduler.start()`（必须在工具注册完成之后）
 *   → 发布 `ctx.agentScheduler` → 绑定 teardown。
 *
 * 降级策略：
 *   - `scheduler.enabled === false`：直接返回，不注册工具、不建 timer、不发布服务；
 *   - `tasksDir` 非法（绝对路径 / 越界）：warn 后回落到默认目录；
 *   - `tools` 服务缺失或 `register` 不可用：warn，仍从磁盘加载任务并启动调度；
 *   - 工具重名 / 单个注册失败：warn + 回滚已注册项，不阻断调度；
 *   - teardown 绑定失败：warn（生命周期兜底能力缺失，但不影响本次运行）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
// 仅加载 `agent/created` 事件的模块增强；调度装配只读事件。
import type {} from '@deepseek-ai/dsh-agent'
import type { SchedulerConfig } from '../config.js'
import { AgentSchedulerService } from './agent-service.js'
import { createDeliveryPort } from './deliver.js'
import type { AgentBaseDeliveryPort, DeliveryEventsLike } from './deliver.js'
import { createSchedulerService } from './service.js'
import type { SchedulerService } from './service.js'
import { createStateStore, defaultStatePath } from './state.js'
import type { StateStore } from './state.js'
import { DEFAULT_TASKS_SUBDIR, createTaskStore, resolveTasksDir } from './store.js'
import type { TaskStore } from './store.js'
import { createSchedulerTools } from './tools.js'

/** 工具注册表的最小面（`ctx.tools` 结构兼容；缺失时降级）。 */
interface ToolsRegistryLike {
  register(definition: ToolDefinition): () => void
}

/** mount 层日志出口；四个级别全部存在，调用永不抛。 */
interface MountLogger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
  debug(message: string, meta?: unknown): void
}

/** 日志能力缺失时的兜底出口。 */
const NOOP_LOGGER: MountLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

/** 把任意日志方法包成「永不抛」的调用；非函数则退化为无操作。 */
function guardedLoggerMethod(
  method: unknown,
  receiver: unknown,
): (message: string, meta?: unknown) => void {
  if (typeof method !== 'function') return () => {}
  return (message, meta) => {
    try {
      ;(method as (message: string, meta?: unknown) => void).call(receiver, message, meta)
    } catch {
      // 日志出口自身异常不允许影响装配与运行。
    }
  }
}

/**
 * 获取 mount 日志出口。
 *
 * 优先 `ctx.logger('agent-base:scheduler')`；logger 服务缺失、不是函数、调用抛错
 * 或返回形状不可用时，回落到 {@link NOOP_LOGGER}。返回对象的每个方法都做了异常
 * 隔离，保证后续 `log.warn(...)` 在任何情况下都不会抛给 `apply`。
 */
function resolveMountLogger(ctx: Context): MountLogger {
  try {
    const service = (ctx as unknown as { logger?: unknown }).logger
    if (typeof service !== 'function') return NOOP_LOGGER
    const logger = (service as (name: string) => unknown).call(ctx, 'agent-base:scheduler')
    if (typeof logger !== 'object' || logger === null) return NOOP_LOGGER
    const record = logger as Record<string, unknown>
    return {
      info: guardedLoggerMethod(record.info, logger),
      warn: guardedLoggerMethod(record.warn, logger),
      error: guardedLoggerMethod(record.error, logger),
      debug: guardedLoggerMethod(record.debug, logger),
    }
  } catch {
    return NOOP_LOGGER
  }
}

/** 取工具服务；缺失 / 形状不符返回 `undefined`，绝不抛。 */
function getToolsRegistry(ctx: Context): ToolsRegistryLike | undefined {
  try {
    const tools = (ctx as unknown as { get(name: string): unknown }).get('tools')
    if (
      typeof tools === 'object' &&
      tools !== null &&
      typeof (tools as ToolsRegistryLike).register === 'function'
    ) {
      return tools as ToolsRegistryLike
    }
  } catch {
    // 服务解析失败按「不可用」处理。
  }
  return undefined
}

/** 从 `agent/created` 载荷里取 session id（兼容直接传 id 的测试替身）。 */
function sessionIdOf(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const agent = record.agent as Record<string, unknown> | undefined
  const session = agent?.session as Record<string, unknown> | undefined
  const candidate = session?.id ?? agent?.id ?? record.sessionId ?? record.id
  return typeof candidate === 'string' && candidate !== '' ? candidate : undefined
}

/** 把 Cordis 事件总线适配成投递层需要的 `agent/created` 窄视图。 */
function deliveryEvents(ctx: Context): DeliveryEventsLike {
  return {
    on: (_event, callback) => {
      const off = ctx.on('agent/created' as never, ((payload: unknown) => {
        const sessionId = sessionIdOf(payload)
        if (sessionId !== undefined) callback(sessionId)
      }) as never)
      return () => {
        off()
      }
    },
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 装配调度子系统。
 *
 * @param ctx       插件 fiber 上的 Context。
 * @param config    已补齐默认值的调度配置。
 * @param workspace 固定 workspace 的 canonical 绝对路径。
 * @returns 已发布的诊断服务；`enabled=false` 或装配彻底失败时返回 `undefined`。
 */
export function mountScheduler(
  ctx: Context,
  config: SchedulerConfig,
  workspace: string,
): AgentSchedulerService | undefined {
  // 关闭态必须在任何 logger 访问之前返回：logger 服务缺失/抛错也不能影响 apply。
  if (config?.enabled === false) return undefined
  const log = resolveMountLogger(ctx)

  let scheduler: SchedulerService | undefined
  let delivery: AgentBaseDeliveryPort | undefined
  let state: StateStore | undefined
  let store: TaskStore | undefined
  let cleaned = false
  const disposers: Array<() => void> = []

  /** 幂等清理：stop → 反注册工具 → delivery.dispose。 */
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    try {
      scheduler?.stop()
    } catch (error) {
      log.warn(`停止调度器失败（已忽略）：${describeError(error)}`)
    }
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch (error) {
        log.warn(`反注册调度工具失败（已忽略）：${describeError(error)}`)
      }
    }
    try {
      delivery?.dispose()
    } catch (error) {
      log.warn(`释放投递端口失败（已忽略）：${describeError(error)}`)
    }
  }

  try {
    // 1) 任务目录：配置非法时降级到默认目录，而不是让整个插件启动失败。
    let tasksDir: string
    let relativeTasksDir = config.tasksDir
    try {
      tasksDir = resolveTasksDir(workspace, config.tasksDir)
    } catch (error) {
      log.warn(
        `tasksDir 配置非法（${JSON.stringify(config.tasksDir)}），已降级为默认目录 ` +
          `${JSON.stringify(DEFAULT_TASKS_SUBDIR)}：${describeError(error)}`,
      )
      relativeTasksDir = DEFAULT_TASKS_SUBDIR
      tasksDir = resolveTasksDir(workspace)
    }

    store = createTaskStore({ tasksDir, logger: log })
    state = createStateStore({
      path: defaultStatePath(workspace),
      logger: { warn: (message) => log.warn(message) },
    })
    delivery = createDeliveryPort({
      agents: ctx.agents,
      sessionPersistence: ctx.sessionPersistence,
      mainSessionId: ctx.agentBase.mainSessionId as string,
      deliverOnOffline: config.deliverOnOffline,
      pendingTtlMs: config.pendingTtlMs,
      maxPendingPerTask: config.maxPendingPerTask,
      events: deliveryEvents(ctx),
      logger: log,
    })

    scheduler = createSchedulerService({
      store,
      delivery,
      state,
      logger: log,
      timezone: config.timezone,
      workspace,
      tasksDir: relativeTasksDir,
      maxDeliverChars: config.maxDeliverChars,
      allowScript: config.allowScript,
      timeoutMs: config.scriptTimeoutMs,
      maxStdoutBytes: config.maxOutputBytes,
      maxStderrBytes: config.maxOutputBytes,
    })

    // 2) 注册工具；工具服务缺失时只降级，不影响从磁盘加载任务与调度。
    const tools = getToolsRegistry(ctx)
    if (tools === undefined) {
      log.warn('tools 服务不可用，task_* 工具已跳过注册（调度仍会启动）')
    } else {
      try {
        const definitions = createSchedulerTools({
          store,
          workspace,
          allowScript: config.allowScript,
          allowCustomSession: config.allowCustomSession,
          onChange: () => scheduler?.reload(),
          runNow: (id) => scheduler!.runNow(id),
          logger: log,
        })
        for (const definition of definitions) {
          try {
            const dispose = tools.register(definition)
            disposers.push(typeof dispose === 'function' ? dispose : () => {})
          } catch (error) {
            log.warn(
              `工具 ${definition.name} 注册失败，回滚本次已注册的全部调度工具：` +
                describeError(error),
            )
            for (const registered of disposers.splice(0).reverse()) {
              try {
                registered()
              } catch {
                // 回滚阶段的二次失败无补救手段，忽略。
              }
            }
            break
          }
        }
      } catch (error) {
        log.warn(`创建调度工具失败（已跳过注册）：${describeError(error)}`)
      }
    }

    // 3) 工具注册完成后启动（start 内部逐任务隔离异常）。先启动再发布服务，
    //    避免 start 抛错时留下已注册却不可用的 `ctx.agentScheduler`。
    scheduler.start()

    // 4) 发布只读诊断服务。
    const service = new AgentSchedulerService(ctx, scheduler)

    // 5) 生命周期兜底；绑定失败只 warn。
    try {
      ctx.effect(() => () => cleanup(), 'agent-base:scheduler')
    } catch (error) {
      log.warn(`调度 teardown 绑定失败（生命周期兜底缺失）：${describeError(error)}`)
    }

    return service
  } catch (error) {
    log.warn(`调度子系统装配失败，定时能力已降级：${describeError(error)}`)
    cleanup()
    return undefined
  }
}

