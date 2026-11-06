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
import { statSync } from 'node:fs'
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

/** 日志能力缺失时的兜底出口（warn / error 走 console，info / debug 静默）。 */
function consoleLogger(): MountLogger {
  return {
    info: () => {},
    debug: () => {},
    warn: guardedLoggerMethod(
      typeof console.warn === 'function' ? console.warn : undefined,
      console,
    ),
    error: guardedLoggerMethod(
      typeof console.error === 'function' ? console.error : undefined,
      console,
    ),
  }
}

/**
 * 把任意日志方法包成「永不抛」的调用；非函数则退化为无操作。
 *
 * 实参个数与入参严格对齐：`meta === undefined` 时只传 `message`。这对基于
 * `util.format` 的控制台 logger 很关键——多传一个 `undefined` 会让每条日志
 * 末尾多出 ` undefined`。需要直接单测，故以具名导出暴露（未进入包入口）。
 */
export function guardedLoggerMethod(
  method: unknown,
  receiver: unknown,
): (message: string, meta?: unknown) => void {
  if (typeof method !== 'function') return () => {}
  return (message, meta) => {
    try {
      const target = method as (message: string, meta?: unknown) => void
      if (meta === undefined) {
        target.call(receiver, message)
      } else {
        target.call(receiver, message, meta)
      }
    } catch {
      // 日志出口自身异常不允许影响装配与运行。
    }
  }
}

/**
 * 从任意候选值提取日志出口；不可用返回 `undefined`。
 *
 * 支持三种形态（按顺序在 {@link resolveMountLogger} 中尝试）：
 *   - 普通对象，带 `info` / `warn` / `error` / `debug` 中的任意方法；
 *   - 函数（可调用 logger），方法属性优先，缺失级别直接用函数本身；
 *   - 其它 → 不可用。
 *
 * 缺失的级别退化为无操作；所有方法都做异常隔离，绝不向上抛。
 */
function mountLoggerFrom(candidate: unknown, receiver: unknown): MountLogger | undefined {
  if (candidate === undefined || candidate === null) return undefined

  if (typeof candidate === 'function') {
    const record = candidate as unknown as Record<string, unknown>
    const hasLevel = LEVELS.some((level) => typeof record[level] === 'function')
    if (!hasLevel) {
      // 纯函数 logger：四个级别共用同一个函数。
      return {
        info: guardedLoggerMethod(candidate, undefined),
        warn: guardedLoggerMethod(candidate, undefined),
        error: guardedLoggerMethod(candidate, undefined),
        debug: guardedLoggerMethod(candidate, undefined),
      }
    }
    return {
      info: guardedLoggerMethod(record.info ?? candidate, record.info ? candidate : undefined),
      warn: guardedLoggerMethod(record.warn ?? candidate, record.warn ? candidate : undefined),
      error: guardedLoggerMethod(record.error ?? candidate, record.error ? candidate : undefined),
      debug: guardedLoggerMethod(record.debug ?? candidate, record.debug ? candidate : undefined),
    }
  }

  if (typeof candidate !== 'object') return undefined
  const record = candidate as Record<string, unknown>
  if (!LEVELS.some((level) => typeof record[level] === 'function')) return undefined
  return {
    info: guardedLoggerMethod(record.info, candidate),
    warn: guardedLoggerMethod(record.warn, candidate),
    error: guardedLoggerMethod(record.error, candidate),
    debug: guardedLoggerMethod(record.debug, candidate),
  }
}

const LEVELS = ['info', 'warn', 'error', 'debug'] as const

/**
 * 获取 mount 日志出口（任何分支都不抛异常）。
 *
 * 顺序：
 *   1. `ctx.logger('agent-base:scheduler')`——返回对象或函数都可用；
 *   2. `ctx.logger` 自身带日志方法（非可调用形态）；
 *   3. 都不可用 → warn / error 回落 `console.warn` / `console.error`，
 *      info / debug 静默。
 *
 * 解析阶段一旦失败（属性访问抛错 / 工厂调用抛错），继续尝试后续分支，
 * 最终一定返回一个可安全调用的出口。
 */
function resolveMountLogger(ctx: Context): MountLogger {
  let service: unknown
  try {
    service = (ctx as unknown as { logger?: unknown }).logger
  } catch {
    return consoleLogger()
  }

  if (typeof service === 'function') {
    try {
      const produced = (service as (name: string) => unknown).call(ctx, 'agent-base:scheduler')
      // 工厂返回值可以是对象，也可以是可直接调用的 logger 函数。
      const fromFactory = mountLoggerFrom(produced, produced)
      if (fromFactory !== undefined) return fromFactory
    } catch {
      // 工厂自身抛错：按不可用处理，走 console 兜底。
    }
    return consoleLogger()
  }

  // 非可调用形态：`ctx.logger` 自身就带日志方法。
  try {
    const direct = mountLoggerFrom(service, ctx)
    if (direct !== undefined) return direct
  } catch {
    // 访问日志方法时抛错：走 console 兜底。
  }

  return consoleLogger()
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

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
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
  // 关闭态也要留一条可见日志；logger 解析全程不抛，缺失时走 console 兜底。
  if (config?.enabled === false) {
    resolveMountLogger(ctx).info('调度已禁用（scheduler.enabled=false）')
    return undefined
  }
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
    const stats = scheduler.start()
    log.info(
      `调度器已启动：任务目录=${tasksDir}，时区=${scheduler.timezone}，` +
        `已排定 ${stats.scheduled} 个任务（禁用 ${stats.disabled}，损坏 ${stats.corrupted}）`,
    )
    // 空目录 / 目录缺失 / 路径被文件占用是「启动正常但静默无事可做」的最常见根因，
    // 必须可见。`existsSync` 无法区分「不存在」「不是目录」「不可访问」，故用
    // `statSync` 分情况提示；任何 stat 失败都只 warn，不阻断 mount（store 自身
    // 会兜住读取失败）。
    let dirStat: ReturnType<typeof statSync> | undefined
    try {
      dirStat = statSync(tasksDir)
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') {
        log.warn(`任务目录不存在：${tasksDir}（首次使用请创建，或用 task_create 新建任务）`)
      } else {
        log.warn(`任务目录不可访问：${tasksDir}：${describeError(error)}`)
      }
    }
    if (dirStat !== undefined) {
      if (!dirStat.isDirectory()) {
        log.warn(`任务目录不是目录：${tasksDir}（该路径被文件占用，无法作为 tasksDir）`)
      } else if (stats.total === 0 && stats.corrupted === 0) {
        log.warn(`任务目录为空：${tasksDir}，当前没有可调度任务`)
      }
    }

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

