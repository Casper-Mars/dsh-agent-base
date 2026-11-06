/**
 * 调度器装配（技术方案 §5.4 / §7 / §9）：`start` / `stop` / `reload` + 每任务一条
 * 链式 timer。
 *
 * 语义（逐条对应验收标准）：
 *   - **不阻塞下一轮**：`fire()` 只 `void runNow(...)`，执行在后台结算；下一次
 *     timer 在触发时立刻按 cron 装好，并在 run 结算后的 `finally` 里再按代际守卫
 *     重算一次（同一 id 先清旧句柄，永不叠加）。这样长任务执行期间的下一次到点
 *     能被单飞锁看见并判为 `skipped`，而不是「没有 timer 所以永远不会到点」；
 *   - **单飞锁**：`inFlight: Map<id, Promise>`，定时触发与 `runNow` 共用；被占用
 *     时本次直接返回 `skipped`（reason 含 `already running`），**不排队**——排队
 *     会在长任务下无限堆积，反而放大唤醒风暴；
 *   - **代际守卫**：`stop` / `reload` 让 `epoch` 自增，旧 fire 的 `finally` 见到
 *     代际变化后不再补 timer；
 *   - **timer 登记表**：每个 `setTimer` 句柄都进 `liveTimers`，同 id 重装前先清
 *     旧句柄，`stop` / `reload` 清全部——不允许孤儿定时器；
 *   - **异常隔离**：cron 非法 / 任务文件损坏 / 单任务装配异常只 warn，其它任务
 *     照常调度；
 *   - **超长延时保护**：`setTimeout` 超过 2^31-1ms 会被截断成「立即触发」，这里
 *     把延时截到上限并记录目标时刻，提前醒来时只重装不执行。
 *
 * 依赖（存储 / 投递 / 执行 / 状态 / 时钟 / 定时器）全部可注入，单测用 fake timer，
 * 不真实 sleep、不起子进程。
 */
import { next as cronNext, isValidCron, parseCron } from './cron.js'
import type { CronSchedule } from './cron.js'
import { createNodeExecStrategy } from './runner.js'
import { createStateStore, defaultStatePath } from './state.js'
import type { TaskStatus } from './state.js'
import type { TaskStore } from './store.js'
import { createCooldownStore, runTask } from './task.js'
import { formatIsoInZone } from './text.js'
import type {
  CooldownStore,
  RunTaskDeps,
  TaskDeliveryPort,
  TaskStatePort,
} from './task.js'
import type {
  Clock,
  ExecStrategy,
  TaskDef,
  TaskRunOutcome,
  Timer,
  TimerHandle,
} from './types.js'

/** `setTimeout` 允许的最大延时（2^31-1ms，约 24.8 天）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** 日志出口：与 task 层同形态，额外支持可选的 `debug`。 */
export type SchedulerLogger =
  | {
      info?(message: string, meta?: unknown): void
      warn?(message: string, meta?: unknown): void
      error?(message: string, meta?: unknown): void
      debug?(message: string, meta?: unknown): void
    }
  | ((message: string, meta?: unknown) => void)

interface NormalizedLogger {
  readonly info: (message: string, meta?: unknown) => void
  readonly warn: (message: string, meta?: unknown) => void
  readonly error: (message: string, meta?: unknown) => void
  readonly debug: (message: string, meta?: unknown) => void
}

/** 归一化日志出口；未注入时全部为无操作。 */
function loggerOf(logger: SchedulerLogger | undefined): NormalizedLogger {
  if (logger === undefined) {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  }
  if (typeof logger === 'function') {
    return { info: logger, warn: logger, error: logger, debug: logger }
  }
  return {
    info: (message, meta) => logger.info?.(message, meta),
    warn: (message, meta) => logger.warn?.(message, meta),
    error: (message, meta) => logger.error?.(message, meta),
    debug: (message, meta) => logger.debug?.(message, meta),
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 原生定时器（`unref` 让调度器不阻止进程退出）。 */
function nativeTimer(): Timer {
  return {
    setTimer(delayMs, cb) {
      const handle = setTimeout(cb, delayMs)
      if (typeof (handle as { unref?: () => void }).unref === 'function') {
        ;(handle as { unref: () => void }).unref()
      }
      return handle
    },
    clearTimer(handle) {
      clearTimeout(handle)
    },
  }
}

/** {@link SchedulerService} 选项。 */
export interface SchedulerServiceOptions {
  /** 任务清单来源（`TaskStore` 结构兼容；测试可注入 fake）。 */
  readonly store: Pick<TaskStore, 'list' | 'get'>
  /** 投递端口（结果消息与失败通知共用）。 */
  readonly delivery: TaskDeliveryPort
  /** 失败 / 成功状态；缺省落在 `<workspace>/.agent-base/state/scheduler.json`。 */
  readonly state?: TaskStatePort
  /** 执行策略；缺省 node 子进程策略（测试必须注入 fake）。 */
  readonly exec?: ExecStrategy
  /** 时钟；缺省系统时间。 */
  readonly clock?: Clock
  /** 定时器；缺省原生 `setTimeout`。 */
  readonly timer?: Timer
  /** 日志出口。 */
  readonly logger?: SchedulerLogger
  /** 任务时区（cron 按它计算）；缺省进程本地时区。 */
  readonly timezone?: string
  /** 固定 workspace（解析相对 `task_path`、默认状态文件路径）。 */
  readonly workspace: string
  /** 任务定义目录（相对 workspace，失败通知展示用）；缺省 `.agent-base/tasks`。 */
  readonly tasksDir?: string
  /** 正文预算（字素）。 */
  readonly maxDeliverChars?: number
  /** 是否允许执行脚本任务；缺省允许。 */
  readonly allowScript?: boolean
  /** 冷却记录；缺省本实例独享一份内存记录。 */
  readonly cooldown?: CooldownStore
  /** 执行超时（毫秒）。 */
  readonly timeoutMs?: number
  /** stdout 上限（字节）。 */
  readonly maxStdoutBytes?: number
  /** stderr 上限（字节）。 */
  readonly maxStderrBytes?: number
  /** 触发期文件校验（测试注入）。 */
  readonly validate?: RunTaskDeps['validate']
}

/** 一次任务清单加载的统计（启动日志与诊断用）。 */
export interface SchedulerLoadStats {
  /** 有效任务总数（不含损坏文件）。 */
  readonly total: number
  /** 声明为启用的任务数。 */
  readonly enabled: number
  /** 声明为禁用的任务数。 */
  readonly disabled: number
  /** 损坏 / 结构非法的任务文件数。 */
  readonly corrupted: number
  /** 实际排定成功（已装 timer）的任务数。 */
  readonly scheduled: number
}

/** 已排定的任务（每个 id 一条链）。 */
interface ScheduledEntry {
  readonly schedule: CronSchedule
  /** 本次 timer 的目标触发时刻（毫秒）；用于超长延时提前醒来的判断。 */
  readonly nextAtMs: number
  /** 当前 timer 句柄。 */
  readonly handle: TimerHandle
}

/**
 * 多任务调度器。
 *
 * 任务通过 `store.list()` 读取；每条 `enabled` 且 cron 合法的任务拥有独立 timer，
 * 触发后链式重排下一次。`start` / `stop` / `reload` 幂等。
 */
export class SchedulerService {
  /** 任务时区。 */
  readonly timezone: string
  /** 任务清单来源。 */
  readonly store: Pick<TaskStore, 'list' | 'get'>

  private readonly delivery: TaskDeliveryPort
  private readonly state: TaskStatePort
  private readonly execStrategy: ExecStrategy
  private readonly clock: Clock
  private readonly timer: Timer
  private readonly log: NormalizedLogger
  private readonly logger: SchedulerLogger | undefined
  private readonly workspace: string
  private readonly tasksDir: string | undefined
  private readonly maxDeliverChars: number | undefined
  private readonly allowScript: boolean | undefined
  private readonly cooldown: CooldownStore
  private readonly timeoutMs: number | undefined
  private readonly maxStdoutBytes: number | undefined
  private readonly maxStderrBytes: number | undefined
  private readonly validate: RunTaskDeps['validate']

  private started = false
  /** 代际：`stop` / `reload` 自增，旧 fire 不再补 timer。 */
  private epoch = 0
  private readonly scheduled = new Map<string, ScheduledEntry>()
  /**
   * 已登记、尚未清理的 timer 句柄（全量）。
   *
   * `scheduled` 只保留每个 id 的**当前**句柄，同 id 重装会覆盖旧值；单独登记
   * 一份集合保证 `stop` / `reload` 不会漏清历史句柄。
   */
  private readonly liveTimers = new Set<TimerHandle>()
  /** 同任务单飞锁：`task_id -> 在飞 promise`（定时触发与 runNow 共用）。 */
  private readonly inFlight = new Map<string, Promise<TaskRunOutcome>>()
  /** 最近一次触发结局（含单飞跳过），诊断用。 */
  private readonly outcomes = new Map<string, TaskRunOutcome>()

  constructor(options: SchedulerServiceOptions) {
    if (typeof options.workspace !== 'string' || options.workspace.trim() === '') {
      throw new TypeError('[scheduler/service] workspace 必须是非空字符串')
    }
    this.workspace = options.workspace
    this.store = options.store
    this.delivery = options.delivery
    this.clock = options.clock ?? { now: () => new Date() }
    this.timer = options.timer ?? nativeTimer()
    this.logger = options.logger
    this.log = loggerOf(options.logger)
    this.timezone =
      options.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      'UTC'
    this.tasksDir = options.tasksDir
    this.maxDeliverChars = options.maxDeliverChars
    this.allowScript = options.allowScript
    this.cooldown = options.cooldown ?? createCooldownStore()
    this.timeoutMs = options.timeoutMs
    this.maxStdoutBytes = options.maxStdoutBytes
    this.maxStderrBytes = options.maxStderrBytes
    this.validate = options.validate

    this.state =
      options.state ??
      createStateStore({
        path: defaultStatePath(options.workspace),
        clock: this.clock,
        ...(options.logger === undefined ? {} : { logger: { warn: this.log.warn } }),
      })
    this.execStrategy = options.exec ?? createNodeExecStrategy()
  }

  /** 是否运行中。 */
  get running(): boolean {
    return this.started
  }

  /** 已排定的任务 id（诊断用，升序）。 */
  get scheduledIds(): string[] {
    return [...this.scheduled.keys()].sort()
  }

  /**
   * 某任务下一次触发时刻；未排定（禁用 / cron 非法 / 不存在）返回 `undefined`。
   *
   * 只读诊断用：取自当前 timer 的目标时刻，不触发重算，也不改变调度状态。
   */
  nextRunAt(taskId: string): Date | undefined {
    const entry = this.scheduled.get(taskId)
    return entry === undefined ? undefined : new Date(entry.nextAtMs)
  }

  /** 启动调度（幂等）；返回本次清单加载统计。 */
  start(): SchedulerLoadStats {
    if (this.started) return this.stats()
    this.started = true
    return this.rebuild()
  }

  /**
   * 停止并清空所有 timer（幂等）。
   *
   * `epoch` 自增让在飞 run 的 `finally` 不再补 timer；`inFlight` 也在此清空
   * （进程内已无法取消已在执行的任务，但锁必须释放，否则 `stop` 后永远
   * 「正在执行」）。
   */
  stop(): void {
    const hadTimers = this.liveTimers.size > 0 || this.scheduled.size > 0
    this.started = false
    this.clearAll(true)
    if (hadTimers) this.log.info('调度器已停止，全部定时器已清理')
  }

  /**
   * 重新加载清单（全量重建，幂等）。
   *
   * 刻意**不清空单飞锁**：reload 期间正在执行的任务结束后才允许下一次触发，
   * 否则会在长任务上叠出第二条执行链。
   */
  reload(): void {
    if (!this.started) return
    this.clearAll(false)
    this.rebuild()
    this.log.info(`调度器已重载，共 ${this.scheduled.size} 个任务在排`)
  }

  /** 任务是否正在执行（单飞锁，诊断用）。 */
  isRunning(taskId: string): boolean {
    return this.inFlight.has(taskId)
  }

  /** 最近一次触发结局（含单飞跳过）；从未触发返回 `undefined`。 */
  lastOutcome(taskId: string): TaskRunOutcome | undefined {
    return this.outcomes.get(taskId)
  }

  /** 任务失败状态（直接读 `StateStore.status`）。 */
  status(taskId: string): TaskStatus {
    return this.state.status(taskId)
  }

  /**
   * 立即执行一次（不影响既有 timer）；与定时触发共用同一把单飞锁。
   *
   * 锁被占用时返回 `skipped`（reason 含 `already running`），**不排队**。
   */
  runNow(taskId: string): Promise<TaskRunOutcome> {
    const running = this.inFlight.get(taskId)
    if (running !== undefined) {
      const skipped: TaskRunOutcome = {
        kind: 'skipped',
        reason: `任务 ${taskId} 已在执行中（already running），本次触发跳过`,
        detail: '单飞锁已占用：本次不排队',
      }
      this.outcomes.set(taskId, skipped)
      // 与其它结局同走 logOutcome，保证 `结局：skipped — reason` 格式统一且只打一条。
      this.logOutcome(taskId, skipped)
      return Promise.resolve(skipped)
    }

    // 代际快照：`stop` / `reload` 之后旧的在飞任务晚结算时，不得覆盖新代际
    // 已经写入的 lastOutcome（否则诊断面会「时光倒流」）。outcome 仍照常返回
    // 给本次调用方，只是不再写入诊断状态。
    const runEpoch = this.epoch
    const promise = this.execute(taskId).then((outcome) => {
      if (runEpoch === this.epoch) {
        this.outcomes.set(taskId, outcome)
        this.logOutcome(taskId, outcome)
      }
      return outcome
    })
    this.inFlight.set(taskId, promise)
    // 锁释放只清「属于本次」的锁，防御未来可能的重入。
    promise
      .finally(() => {
        if (this.inFlight.get(taskId) === promise) this.inFlight.delete(taskId)
      })
      .catch(() => {})
    return promise
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 单飞锁内的真实执行体（runTask 契约上不抛，这里再兜底一次）。 */
  private async execute(taskId: string): Promise<TaskRunOutcome> {
    try {
      return await runTask(taskId, this.runTaskDeps())
    } catch (error) {
      this.log.error(`任务 ${taskId} 执行异常（已隔离）：${describeError(error)}`)
      return {
        kind: 'failed',
        reason: `任务 ${taskId} 执行异常`,
        detail: describeError(error),
        failureKind: 'exec',
        notified: false,
        consecutiveFailures: 0,
      }
    }
  }

  /** 组装 runTask 依赖（每次调用取最新值，任务参数不变）。 */
  private runTaskDeps(): RunTaskDeps {
    return {
      store: this.store,
      delivery: this.delivery,
      exec: this.execStrategy,
      state: this.state,
      clock: this.clock,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      timezone: this.timezone,
      workspace: this.workspace,
      ...(this.tasksDir === undefined ? {} : { tasksDir: this.tasksDir }),
      ...(this.maxDeliverChars === undefined ? {} : { maxDeliverChars: this.maxDeliverChars }),
      ...(this.allowScript === undefined ? {} : { allowScript: this.allowScript }),
      cooldown: this.cooldown,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      ...(this.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: this.maxStdoutBytes }),
      ...(this.maxStderrBytes === undefined ? {} : { maxStderrBytes: this.maxStderrBytes }),
      ...(this.validate === undefined ? {} : { validate: this.validate }),
    }
  }

  private logOutcome(taskId: string, outcome: TaskRunOutcome): void {
    const base = `任务 ${taskId} 结局：${outcome.kind} — ${outcome.reason}`
    if (outcome.kind === 'failed') {
      this.log.warn(`${base}（failureKind=${outcome.failureKind}）`, { taskId })
      return
    }
    if (outcome.kind === 'skipped') {
      this.log.warn(base, { taskId })
      return
    }
    this.log.info(base, { taskId })
  }

  /** 当前清单统计（未启动时为全零）。 */
  private stats(): SchedulerLoadStats {
    return { total: 0, enabled: 0, disabled: 0, corrupted: 0, scheduled: this.scheduled.size }
  }

  /** 清空全部 timer；`clearInFlight` 决定是否同时释放单飞锁。 */
  private clearAll(clearInFlight: boolean): void {
    this.epoch += 1
    const handles = new Set<TimerHandle>(this.liveTimers)
    for (const entry of this.scheduled.values()) handles.add(entry.handle)
    for (const handle of handles) {
      try {
        this.timer.clearTimer(handle)
      } catch (error) {
        this.log.warn(`清理定时器失败（已忽略）：${describeError(error)}`)
      }
    }
    this.liveTimers.clear()
    this.scheduled.clear()
    if (clearInFlight) this.inFlight.clear()
  }

  /** 读取任务清单并逐条装配；清单读取失败只 warn。 */
  private rebuild(): SchedulerLoadStats {
    let listed: { tasks: TaskDef[]; corrupted: string[] }
    try {
      listed = this.store.list()
    } catch (error) {
      this.log.warn(`读取任务清单失败（本轮跳过）：${describeError(error)}`)
      return this.stats()
    }

    if (listed.corrupted.length > 0) {
      this.log.warn(
        `跳过 ${listed.corrupted.length} 个损坏任务文件：${listed.corrupted.join(', ')}`,
      )
    }

    for (const task of listed.tasks) this.scheduleTask(task)

    const total = listed.tasks.length
    const enabled = listed.tasks.filter((task) => task.enabled).length
    const disabled = total - enabled
    const stats: SchedulerLoadStats = {
      total,
      enabled,
      disabled,
      corrupted: listed.corrupted.length,
      scheduled: this.scheduled.size,
    }
    this.log.info(
      `任务清单加载完成：共 ${stats.total}，启用 ${stats.enabled}，禁用 ${stats.disabled}，损坏 ${stats.corrupted}`,
    )
    return stats
  }

  /** 单任务装配：禁用 / cron 非法 / 装配异常都只影响该任务。 */
  private scheduleTask(task: TaskDef): void {
    try {
      if (!task.enabled) {
        this.log.debug(`任务 ${task.id} 已禁用，跳过调度`)
        return
      }
      if (!isValidCron(task.cron)) {
        this.log.warn(`任务 ${task.id} cron 非法（${JSON.stringify(task.cron)}），已跳过`)
        return
      }
      const schedule = parseCron(task.cron)
      const nextAtMs = this.arm(task.id, schedule)
      this.log.debug(
        `任务 ${task.id} 已排定：下次触发 ${this.describeNextRun(nextAtMs)}（cron=${task.cron}）`,
      )
    } catch (error) {
      // 装配失败：清掉可能已装的半成品句柄，保证不留下「跑不了也停不掉」的 timer。
      this.disarm(task.id)
      this.log.warn(`任务 ${task.id} 装配失败（已跳过）：${describeError(error)}`)
    }
  }

  /** 清掉某 id 的当前 timer 与登记项。 */
  private disarm(taskId: string): void {
    const existing = this.scheduled.get(taskId)
    if (existing === undefined) return
    this.scheduled.delete(taskId)
    this.liveTimers.delete(existing.handle)
    try {
      this.timer.clearTimer(existing.handle)
    } catch (error) {
      this.log.warn(`清理任务 ${taskId} 的定时器失败（已忽略）：${describeError(error)}`)
    }
  }

  /**
   * 为任务装下一次 timer（同 id 先清旧句柄，绝不叠加）。
   *
   * 延时按「当前时钟 → 下一次 cron 时刻」计算；超过 `setTimeout` 上限时截到
   * 上限并记录目标时刻，提前醒来由 {@link fire} 判断是否只重装。
   */
  private arm(taskId: string, schedule: CronSchedule): number {
    this.disarm(taskId)

    const now = this.clock.now()
    const nextAt = cronNext(schedule, now, this.timezone)
    const targetMs = nextAt.getTime()
    const delay = Math.max(targetMs - now.getTime(), 0)
    const handle = this.timer.setTimer(Math.min(delay, MAX_TIMER_DELAY_MS), () => {
      this.fire(taskId)
    })
    this.liveTimers.add(handle)
    this.scheduled.set(taskId, { schedule, nextAtMs: targetMs, handle })
    return targetMs
  }

  /** 下次触发时刻的日志文本；时区非法时退回 UTC ISO，日志不得影响调度。 */
  private describeNextRun(targetMs: number): string {
    const date = new Date(targetMs)
    try {
      return formatIsoInZone(date, this.timezone)
    } catch {
      return date.toISOString()
    }
  }

  /**
   * 到点触发：**不阻塞**下一轮。
   *
   * 顺序：取走当前句柄 → 立即装下一次（让长任务期间的下一次到点能被单飞锁看见）
   * → `void runNow` → `finally` 中按代际守卫重算并替换下一次 timer。
   */
  private fire(taskId: string): void {
    try {
      this.fireOnce(taskId)
    } catch (error) {
      // timer 回调里抛错会变成 uncaughtException：这里必须完全兜住。
      this.log.warn(`任务 ${taskId} 触发异常（已隔离）：${describeError(error)}`)
    }
  }

  /** {@link fire} 的实际执行体（异常由外层兜底）。 */
  private fireOnce(taskId: string): void {
    const entry = this.scheduled.get(taskId)
    if (entry === undefined) return
    this.scheduled.delete(taskId)
    this.liveTimers.delete(entry.handle)

    // 超长延时被截断导致提前醒来：还没到目标时刻，只重装不执行。
    if (this.clock.now().getTime() < entry.nextAtMs) {
      this.arm(taskId, entry.schedule)
      return
    }

    const fireEpoch = this.epoch
    this.log.info(`任务 ${taskId} 到点触发`)

    // 先把下一次装上：长任务执行期间的下一次到点才能被单飞锁判为 skipped。
    this.arm(taskId, entry.schedule)

    void this.runNow(taskId)
      .catch((error: unknown) => {
        // runNow 契约上不 reject；这里只兜底，绝不能穿透到 timer 回调。
        this.log.error(`任务 ${taskId} 触发异常（已隔离）：${describeError(error)}`)
      })
      .finally(() => {
        if (!this.started || fireEpoch !== this.epoch) return
        try {
          this.arm(taskId, entry.schedule)
        } catch (error) {
          this.log.warn(
            `任务 ${taskId} 重算下次触发失败，调度链终止：${describeError(error)}`,
          )
          this.disarm(taskId)
        }
      })
  }
}

/** 创建调度器。 */
export function createSchedulerService(
  options: SchedulerServiceOptions,
): SchedulerService {
  return new SchedulerService(options)
}
