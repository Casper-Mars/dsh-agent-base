/**
 * 投递层：目标解析、producer 自有消息源与内存 outbox（技术方案 D5 / D6 / D12）。
 *
 * 三条边界：
 *   1. **目标解析与开关无关**：任务定义的 `session_id` 在运行期始终生效；
 *      `allowCustomSession` 只控制工具 schema 是否暴露该字段，本模块不接收、
 *      也不读取它。自定义 session 不可达时按 D5 **记 error 并回退 main**。
 *   2. **消息必须带 producer 自有 kind**：V4 会话格式拒绝 `source.kind ===
 *      'plugin'`，notice 用 `'dsh-agent-base'` 声明归属，否则写入被 codec 拒绝。
 *   3. **离线补投只在内存**：每任务合计最多 20 条、TTL 10 分钟；过期即丢弃并
 *      记 `missed` 日志。没有真实 timer，过期由注入时钟判定、由外部调用
 *      {@link AgentBaseDeliveryPort.expire} 清理。
 *
 * 失败路径一律不抛：投递失败降级为 `skipped`，由上层 runner 记账；失败通知
 * （D12）复用同一端口，目标不可达时改投 main 一次，仍不可达则入 outbox。
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  Clock,
  DeliveryInput,
  DeliveryResult,
  DeliveryTarget,
  TaskDef,
} from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * dsh-agent-base 的 notice（定时任务唤醒 / 失败通知）。
     *
     * `traceId`（可选）为跨进程关联锚点；无 trace 时不写该字段。
     * @persistenceAttribution
     */
    'dsh-agent-base':
      | ({ kind: 'dsh-agent-base' } & ContextFormed & { readonly traceId?: string })
      | {
          kind: 'dsh-agent-base'
          form: 'notice'
          summary: string
          readonly traceId?: string
        }
  }
}

/** dsh-agent-base 生产者自有 kind（V4 要求非空字符串且 ≠ `'plugin'`）。 */
export const PRODUCER_KIND = 'dsh-agent-base' as const

/** notice 形态的消息源：`form: 'notice'` 必须携带 `summary`（one-line account）。 */
export type NoticeMessageSource = {
  readonly kind: typeof PRODUCER_KIND
  readonly form: 'notice'
  readonly summary: string
  /** 跨进程关联锚点（可选）；无 trace 时不写该字段。 */
  readonly traceId?: string
}

/** notice 形态的 user 消息（`role: 'user'`，source 为 dsh-agent-base notice）。 */
export type NoticeUserMessage = UserMessage & {
  readonly role: 'user'
  readonly source: NoticeMessageSource
}

/**
 * 构造一条 notice 形态的 user 消息（官方 `createUserMessage`：冻结 + 稳定 id）。
 *
 * @param text 模型可见正文。
 * @param summary notice 一行摘要；缺省按 {@link boundContextSummary} 截断正文。
 * @param traceId 可选跨进程关联锚点；缺省（`undefined`）时**不写**该字段。
 */
export function createNoticeMessage(
  text: string,
  summary?: string,
  traceId?: string,
): NoticeUserMessage {
  const source: NoticeMessageSource = {
    kind: PRODUCER_KIND,
    form: 'notice',
    summary: summary ?? boundContextSummary(text),
    ...(traceId === undefined ? {} : { traceId }),
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
}

/** agent 注册表的窄视图：只允许 `get`，命中对象只要求 `followup`。 */
export interface DeliveryAgentsLike {
  get(id: string): { followup(message: unknown): void } | undefined
}

/**
 * 会话持久化的窄视图：只允许 `stat`。
 *
 * `undefined` 表示会话不存在；有值表示存在快照（可能未 live）。实现抛错
 * 视为「无法确认」，按回退 main 处理。
 */
export interface DeliveryPersistenceLike {
  stat(id: string, options?: unknown): Promise<unknown | undefined>
}

/** 日志出口：`{info,warn,error}` 对象或单函数（两者都当作同一出口）。 */
export type DeliveryLogger =
  | {
      info?(message: string, meta?: unknown): void
      warn?(message: string, meta?: unknown): void
      error?(message: string, meta?: unknown): void
    }
  | ((message: string, meta?: unknown) => void)

/** 事件总线窄视图：仅订阅 `agent/created`，返回取消订阅函数。 */
export interface DeliveryEventsLike {
  on(event: 'agent/created', cb: (sessionId: string) => void): () => void
}

/** {@link createDeliveryPort} 的选项。 */
export interface CreateDeliveryPortOptions {
  /** agent 注册表（`agents.get`）。 */
  readonly agents: DeliveryAgentsLike
  /** 会话持久化（区分「不存在」与「存在但未 live」）；可选。 */
  readonly sessionPersistence?: DeliveryPersistenceLike
  /** 固定 main session id（回退目标）。 */
  readonly mainSessionId: string
  /** 目标非 live 时的行为：入内存 outbox（默认）或直接跳过。 */
  readonly deliverOnOffline?: 'queue' | 'skip'
  /** outbox 条目 TTL（毫秒，默认 10 分钟）。 */
  readonly pendingTtlMs?: number
  /** 每任务在全部桶中的合计上限（默认 20）。 */
  readonly maxPendingPerTask?: number
  /** 时钟；默认读系统时间。 */
  readonly clock?: Clock
  /** 日志；默认无操作。 */
  readonly logger?: DeliveryLogger
  /** 事件总线；传入则自动订阅 `agent/created` 触发对应桶 flush。 */
  readonly events?: DeliveryEventsLike
}

/** 投递端口（含 outbox 运维面）。 */
export interface AgentBaseDeliveryPort {
  /** 解析实际投递目标（自定义 session 不可达时回退 main）。 */
  resolveTarget(task: TaskDef): Promise<DeliveryTarget>
  /** 投递一条消息；返回最终结果，永不抛。 */
  deliver(input: DeliveryInput): Promise<DeliveryResult>
  /** 投递失败通知：目标不可达时改投 main 一次；永不抛。 */
  deliverNotice(input: DeliveryInput): Promise<DeliveryResult>
  /** 立即补投某个会话的 outbox，按入队顺序；返回投递 / 丢弃计数。 */
  flush(sessionId: string): Promise<{ delivered: number; missed: number }>
  /** 清理所有过期条目，返回丢弃数。 */
  expire(now?: Date): number
  /** 待补投条数（给定会话时为该桶条数）。 */
  pendingCount(sessionId?: string): number
  /** 取消 events 订阅并清空 outbox。 */
  dispose(): void
}

/** 默认 TTL：10 分钟。 */
export const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000
/** 每任务默认上限：20 条。 */
export const DEFAULT_MAX_PENDING_PER_TASK = 20

interface NormalizedLogger {
  readonly info: (message: string, meta?: unknown) => void
  readonly warn: (message: string, meta?: unknown) => void
  readonly error: (message: string, meta?: unknown) => void
}

/** 归一化日志出口；未注入时全部为无操作。 */
function loggerOf(logger: DeliveryLogger | undefined): NormalizedLogger {
  if (logger === undefined) {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }
  if (typeof logger === 'function') {
    return { info: logger, warn: logger, error: logger }
  }
  return {
    info: (message, meta) => logger.info?.(message, meta),
    warn: (message, meta) => logger.warn?.(message, meta),
    error: (message, meta) => logger.error?.(message, meta),
  }
}

const systemClock: Clock = { now: () => new Date() }

/** outbox 条目。 */
interface PendingEntry {
  readonly taskId: string
  readonly text: string
  readonly summary: string
  readonly fallbackFrom?: string
  /** 入队时刻（毫秒时间戳）。 */
  readonly enqueuedAt: number
  /** 全局递增序号，保证 flush 顺序。 */
  readonly seq: number
}

/** 投递 / 入队 / 丢弃的公共失败文案。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 日志 meta：`fallbackFrom` 有值时才写入。
 *
 * 回退链路（D5 / D12）需要在日志里同时看到「投到哪」与「从哪回退」，
 * 否则排障时无法区分正常投递与回退投递。
 */
function deliveryMeta(
  taskId: string,
  sessionId: string,
  fallbackFrom?: string,
): Record<string, unknown> {
  return fallbackFrom === undefined
    ? { taskId, sessionId }
    : { taskId, sessionId, fallbackFrom }
}

/**
 * 跳过原因：内部区分 `skipped` 的子场景。
 *
 * 只有真正的投递失败才允许失败通知回退 main；去重跳过（`dedupe`）与
 * outbox 超限（`overflow`）不得回退，否则同一条通知会被重复投到 main。
 */
type SkipReason = 'dedupe' | 'delivery-error' | 'offline-skip' | 'overflow'

/** 内部投递结局：公开 {@link DeliveryResult} + 跳过原因 + 入队序号。 */
type InternalOutcome =
  | { readonly status: 'delivered' }
  | {
      readonly status: 'queued'
      readonly sessionId: string
      readonly seq: number
    }
  | { readonly status: 'skipped'; readonly reason: SkipReason }
  | { readonly status: 'failed'; readonly reason: string }

/** 目标不可达：需要失败通知改投 main 的情形。 */
function isUnreachable(outcome: InternalOutcome): boolean {
  if (outcome.status === 'queued') return true
  if (outcome.status !== 'skipped') return false
  // 去重跳过 = 同一消息已有在途投递，不是「投不到」；
  // 超限 = 该任务全桶已满，改投 main 同样会被拒，不做无意义回退。
  return outcome.reason === 'delivery-error' || outcome.reason === 'offline-skip'
}

/** 内部结局 → 公开投递结果。 */
function toResult(outcome: InternalOutcome): DeliveryResult {
  return outcome.status
}

/**
 * 创建投递端口。
 *
 * outbox 只存在内存中，从不落盘；进程退出即丢失（与「有限补投」的定位一致）。
 */
export function createDeliveryPort(
  options: CreateDeliveryPortOptions,
): AgentBaseDeliveryPort {
  const agents = options.agents
  const mainSessionId = options.mainSessionId
  const deliverOnOffline = options.deliverOnOffline ?? 'queue'
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS
  const maxPendingPerTask =
    options.maxPendingPerTask ?? DEFAULT_MAX_PENDING_PER_TASK
  const clock = options.clock ?? systemClock
  const sessionPersistence = options.sessionPersistence
  const log = loggerOf(options.logger)

  /** sessionId → 有序条目。 */
  const outbox = new Map<string, PendingEntry[]>()
  /** 并发占位：同一任务 + 目标 + 正文在一个异步窗口内只投一次。 */
  const inFlight = new Set<string>()
  let seq = 0
  let disposed = false

  function dedupeKey(input: DeliveryInput): string {
    return `${input.taskId}\u0000${input.sessionId}\u0000${input.text}`
  }

  /**
   * 该任务在全部桶中的**有效**待补投条数。
   *
   * 过期条目在 `expire` / `flush` 之前仍物理留在 outbox，但不应继续占用
   * 每任务 20 条额度——否则目标长时间离线时，旧条目会把新消息全部挤成
   * overflow，且 flush 时它们本来也会被直接丢弃。
   */
  function countPendingForTask(taskId: string): number {
    const nowMs = clock.now().getTime()
    let total = 0
    for (const bucket of outbox.values()) {
      for (const entry of bucket) {
        if (entry.taskId !== taskId) continue
        if (nowMs - entry.enqueuedAt >= pendingTtlMs) continue
        total += 1
      }
    }
    return total
  }

  /**
   * 入队前物理清掉该任务已过期的条目。
   *
   * 若只「计数时排除过期」而不清理，目标长期离线且从未触发 expire / flush 时，
   * 过期条目会无界堆积并绕过每任务 20 条上限。这里在入口先做一次定向清扫，
   * 既释放额度也约束内存（语义与 expire 一致：过期消息本就只记 missed、不补投）。
   */
  function dropExpiredForTask(taskId: string): void {
    const nowMs = clock.now().getTime()
    for (const [sessionId, bucket] of outbox) {
      const kept = bucket.filter(
        (entry) => entry.taskId !== taskId || nowMs - entry.enqueuedAt < pendingTtlMs,
      )
      if (kept.length === bucket.length) continue
      if (kept.length === 0) outbox.delete(sessionId)
      else outbox.set(sessionId, kept)
    }
  }

  function enqueue(input: DeliveryInput): InternalOutcome {
    dropExpiredForTask(input.taskId)
    if (countPendingForTask(input.taskId) >= maxPendingPerTask) {
      log.warn(
        `dsh-agent-base: missed 投递（任务 ${input.taskId} 的离线队列已达上限 ${maxPendingPerTask} 条）`,
        deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
      )
      return { status: 'skipped', reason: 'overflow' }
    }
    const entry: PendingEntry = {
      taskId: input.taskId,
      text: input.text,
      summary: input.summary,
      ...(input.fallbackFrom === undefined
        ? {}
        : { fallbackFrom: input.fallbackFrom }),
      enqueuedAt: clock.now().getTime(),
      seq: (seq += 1),
    }
    const bucket = outbox.get(input.sessionId)
    if (bucket === undefined) outbox.set(input.sessionId, [entry])
    else bucket.push(entry)
    log.info(
      `dsh-agent-base: 目标 ${input.sessionId} 未 live，消息进入内存 outbox（任务 ${input.taskId}）`,
      deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
    )
    return { status: 'queued', sessionId: input.sessionId, seq: entry.seq }
  }

  /** 撤销刚入队的一条（仅用于失败通知改投 main 时避免重复投递）。 */
  function dropQueued(sessionId: string, seq: number): void {
    const bucket = outbox.get(sessionId)
    if (bucket === undefined) return
    const kept = bucket.filter((entry) => entry.seq !== seq)
    if (kept.length === 0) outbox.delete(sessionId)
    else outbox.set(sessionId, kept)
  }

  /**
   * 单次投递（已持有并发占位）。`agents.get` 抛错按「投递失败」处理，永不抛。
   *
   * 目标为 main 且未 live 时，用 `sessionPersistence.stat` 区分两种情形：
   *   - 有快照 → 会话存在但暂时离线，按 `deliverOnOffline` 入队（瞬态）；
   *   - 无快照 → main 从未 provisioned（启动期准备失败），**不入队**，返回 `failed`。
   * 调度器不创建 / 恢复会话，只如实报告。
   */
  async function deliverOnce(input: DeliveryInput): Promise<InternalOutcome> {
    let agent: { followup(message: unknown): void } | undefined
    try {
      agent = agents.get(input.sessionId)
    } catch (error) {
      log.error(
        `dsh-agent-base: 读取目标 ${input.sessionId} 的 agent 失败：${describeError(error)}`,
        deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
      )
      return { status: 'skipped', reason: 'delivery-error' }
    }
    if (agent !== undefined && typeof agent.followup === 'function') {
      try {
        agent.followup(createNoticeMessage(input.text, input.summary))
        return { status: 'delivered' }
      } catch (error) {
        log.error(
          `dsh-agent-base: 投递到 ${input.sessionId} 失败：${describeError(error)}`,
          deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
        )
        return { status: 'skipped', reason: 'delivery-error' }
      }
    }
    if (input.sessionId === mainSessionId && sessionPersistence !== undefined) {
      try {
        const snapshot = await sessionPersistence.stat(mainSessionId)
        if (snapshot === undefined) {
          log.warn(
            `dsh-agent-base: 目标 main session 未 provisioned（任务 ${input.taskId}）；` +
              '请检查 workspace 启动阶段是否成功创建 main',
            deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
          )
          return {
            status: 'failed',
            reason: `main session '${mainSessionId}' 未 provisioned`,
          }
        }
      } catch (error) {
        // 无法确认是否存在：按「存在但离线」处理，保持原有的有限补投语义。
        log.warn(
          `dsh-agent-base: 无法确认 main session 是否存在（任务 ${input.taskId}）：` +
            describeError(error),
          deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
        )
      }
    }
    if (deliverOnOffline === 'skip') {
      log.info(
        `dsh-agent-base: 目标 ${input.sessionId} 未 live，按 skip 策略丢弃（任务 ${input.taskId}）`,
        deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
      )
      return { status: 'skipped', reason: 'offline-skip' }
    }
    return enqueue(input)
  }

  /** 清空指定桶并返回条目（新入队会进入新桶）。 */
  function takeBucket(sessionId: string): PendingEntry[] {
    const bucket = outbox.get(sessionId)
    if (bucket === undefined) return []
    outbox.delete(sessionId)
    return bucket
  }

  function requeue(sessionId: string, entries: readonly PendingEntry[]): void {
    if (entries.length === 0) return
    const current = outbox.get(sessionId) ?? []
    outbox.set(sessionId, [...entries, ...current])
  }

  async function flush(
    sessionId: string,
  ): Promise<{ delivered: number; missed: number }> {
    const bucket = takeBucket(sessionId)
    if (bucket.length === 0) return { delivered: 0, missed: 0 }

    let delivered = 0
    let missed = 0
    const retained: PendingEntry[] = []

    for (const entry of bucket.sort((a, b) => a.seq - b.seq)) {
      if (clock.now().getTime() - entry.enqueuedAt >= pendingTtlMs) {
        missed += 1
        log.warn(
          `dsh-agent-base: missed 过期丢弃（任务 ${entry.taskId}，目标 ${sessionId}，TTL ${pendingTtlMs}ms）`,
          deliveryMeta(entry.taskId, sessionId, entry.fallbackFrom),
        )
        continue
      }
      let agent: { followup(message: unknown): void } | undefined
      try {
        agent = agents.get(sessionId)
      } catch (error) {
        // 无法确认可达性：保留条目，等待下一次 flush / expire。
        retained.push(entry)
        log.error(
          `dsh-agent-base: flush 时读取目标 ${sessionId} 的 agent 失败：${describeError(error)}`,
          deliveryMeta(entry.taskId, sessionId, entry.fallbackFrom),
        )
        continue
      }
      if (agent === undefined || typeof agent.followup !== 'function') {
        // 仍然不可达：保留条目，等待下一次 flush / expire。
        retained.push(entry)
        log.warn(
          `dsh-agent-base: flush 时目标 ${sessionId} 仍不可达，保留 ${retained.length} 条待补投`,
          deliveryMeta(entry.taskId, sessionId, entry.fallbackFrom),
        )
        continue
      }
      try {
        agent.followup(createNoticeMessage(entry.text, entry.summary))
        delivered += 1
      } catch (error) {
        missed += 1
        log.error(
          `dsh-agent-base: 补投到 ${sessionId} 失败：${describeError(error)}`,
          deliveryMeta(entry.taskId, sessionId, entry.fallbackFrom),
        )
      }
    }

    requeue(sessionId, retained)
    return { delivered, missed }
  }

  let unsubscribe: (() => void) | undefined
  if (options.events !== undefined) {
    unsubscribe = options.events.on('agent/created', (sessionId) => {
      if (disposed) return
      void flush(sessionId).catch((error: unknown) => {
        log.error(
          `dsh-agent-base: agent/created 自动补投失败：${describeError(error)}`,
          { sessionId },
        )
      })
    })
  }

  /** 内部投递（区分跳过原因）；抛错由调用方兜底。 */
  async function deliverInternal(
    input: DeliveryInput,
  ): Promise<InternalOutcome> {
    const key = dedupeKey(input)
    if (inFlight.has(key)) {
      log.info(
        `dsh-agent-base: 同一消息正在投递，跳过重复调用（任务 ${input.taskId} → ${input.sessionId}）`,
        deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
      )
      return { status: 'skipped', reason: 'dedupe' }
    }
    inFlight.add(key)
    try {
      // 让出一次微任务，确保并发调用能观察到占位（followup 是同步的，
      // 不 await 的话第二个调用会在占位释放后才开始）。
      await Promise.resolve()
      return await deliverOnce(input)
    } finally {
      inFlight.delete(key)
    }
  }

  async function deliver(input: DeliveryInput): Promise<DeliveryResult> {
    try {
      return toResult(await deliverInternal(input))
    } catch (error) {
      log.error(
        `dsh-agent-base: 投递异常：${describeError(error)}`,
        deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
      )
      return 'skipped'
    }
  }

  /**
   * 失败通知（D12）：目标不等于 main 且**不可达**（`queued` /
   * `skipped(delivery-error | offline-skip)`）时改投 main 一次；
   * 去重跳过不得回退，目标就是 main 时不重复回退。
   */
  async function deliverNotice(input: DeliveryInput): Promise<DeliveryResult> {
    let outcome: InternalOutcome
    try {
      outcome = await deliverInternal(input)
    } catch (error) {
      log.error(
        `dsh-agent-base: 失败通知投递异常：${describeError(error)}`,
        deliveryMeta(input.taskId, input.sessionId, input.fallbackFrom),
      )
      outcome = { status: 'skipped', reason: 'delivery-error' }
    }

    if (!isUnreachable(outcome) || input.sessionId === mainSessionId) {
      return toResult(outcome)
    }

    // 目标不可达：撤销刚入队的副本，避免它日后 flush 时与 main 回退重复投递。
    if (outcome.status === 'queued') dropQueued(outcome.sessionId, outcome.seq)

    const fallbackFrom = input.fallbackFrom ?? input.sessionId
    log.warn(
      `dsh-agent-base: 失败通知目标 ${input.sessionId} 不可达，改投 main（${mainSessionId}）`,
      deliveryMeta(input.taskId, input.sessionId, fallbackFrom),
    )

    try {
      return toResult(
        await deliverInternal({
          ...input,
          sessionId: mainSessionId,
          fallbackFrom,
        }),
      )
    } catch (error) {
      log.error(
        `dsh-agent-base: 失败通知回退 main 异常：${describeError(error)}`,
        deliveryMeta(input.taskId, mainSessionId, fallbackFrom),
      )
      return 'skipped'
    }
  }

  async function resolveTarget(task: TaskDef): Promise<DeliveryTarget> {
    const custom = task.session_id?.trim()
    if (custom === undefined || custom === '') {
      return { sessionId: mainSessionId }
    }

    const live = agents.get(custom)
    if (live !== undefined && typeof live.followup === 'function') {
      return { sessionId: custom }
    }

    let reason = '无法确认 session 状态'
    if (sessionPersistence !== undefined) {
      try {
        const snapshot = await sessionPersistence.stat(custom)
        if (snapshot === undefined) {
          reason = 'session 不存在'
          log.error(
            `dsh-agent-base: 任务 ${task.id} 的目标 session '${custom}' ${reason}，回退 main（${mainSessionId}）`,
            { taskId: task.id, sessionId: custom, fallbackFrom: custom },
          )
        } else {
          reason = 'session 存在但当前未 live'
          log.error(
            `dsh-agent-base: 任务 ${task.id} 的目标 session '${custom}' ${reason}，回退 main（${mainSessionId}）`,
            { taskId: task.id, sessionId: custom, fallbackFrom: custom },
          )
        }
      } catch (error) {
        reason = '无法确认 session 状态（会话持久化读取失败）'
        log.warn(
          `dsh-agent-base: 任务 ${task.id} 的目标 session '${custom}' 状态无法确认（${describeError(error)}），回退 main（${mainSessionId}）`,
          { taskId: task.id, sessionId: custom, fallbackFrom: custom },
        )
      }
    } else {
      log.error(
        `dsh-agent-base: 任务 ${task.id} 的目标 session '${custom}' 未 live 且未接入会话持久化，回退 main（${mainSessionId}）`,
        { taskId: task.id, sessionId: custom, fallbackFrom: custom },
      )
    }

    return { sessionId: mainSessionId, fallbackFrom: custom, reason }
  }

  function expire(now?: Date): number {
    const at = (now ?? clock.now()).getTime()
    let dropped = 0
    for (const [sessionId, bucket] of [...outbox.entries()]) {
      const kept: PendingEntry[] = []
      for (const entry of bucket) {
        if (at - entry.enqueuedAt >= pendingTtlMs) {
          dropped += 1
          log.warn(
            `dsh-agent-base: missed 过期丢弃（任务 ${entry.taskId}，目标 ${sessionId}，TTL ${pendingTtlMs}ms）`,
            deliveryMeta(entry.taskId, sessionId, entry.fallbackFrom),
          )
        } else {
          kept.push(entry)
        }
      }
      if (kept.length === 0) outbox.delete(sessionId)
      else outbox.set(sessionId, kept)
    }
    return dropped
  }

  function pendingCount(sessionId?: string): number {
    if (sessionId !== undefined) return outbox.get(sessionId)?.length ?? 0
    let total = 0
    for (const bucket of outbox.values()) total += bucket.length
    return total
  }

  function dispose(): void {
    disposed = true
    if (unsubscribe !== undefined) {
      unsubscribe()
      unsubscribe = undefined
    }
    outbox.clear()
    inFlight.clear()
  }

  return {
    resolveTarget,
    deliver,
    deliverNotice,
    flush,
    expire,
    pendingCount,
    dispose,
  }
}
