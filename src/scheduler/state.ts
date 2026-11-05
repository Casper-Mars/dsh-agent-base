/**
 * 调度运行状态持久化（失败分类 / 连续失败计数 / 24h 通知窗口）。
 *
 * 技术方案 D12 的落点：
 *   - 失败按 {@link TaskFailureKind} 分类，连续失败次数落盘（重启不清零）；
 *   - **每任务 24h 内最多一条失败通知**——窗口用 `lastNotifiedAt` 表示，
 *     判断为「从未通知」或「距上次通知 ≥ 24h」（闭区间，恰好 24h 算可通知）；
 *   - 状态文件损坏 / 版本不符一律**降级为空状态 + warn**，绝不阻断调度。
 *
 * 时间字段统一 ISO 8601 字符串（带时区偏移）。状态是跨进程共享的运行期数据，
 * 用带偏移的绝对时刻表达，避免「本地无偏移 ISO」在不同 TZ 的进程间被误读。
 *
 * best-effort 写：任何写盘失败只 `warn`，绝不抛——状态丢失可以接受，调度中断不行。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertTaskId, TASK_ID_PATTERN } from './store.js'
import type { Clock, TaskFailureKind } from './types.js'

/** 状态文件结构版本。 */
export const STATE_VERSION = 1

/** 失败通知最小间隔（24 小时，闭区间）。 */
export const FAILURE_NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 单个任务的失败状态（落盘结构）。 */
export interface TaskFailureState {
  /** 连续失败次数；成功一次即清零。 */
  readonly consecutiveFailures: number
  /** 本轮连续失败的首次失败时刻。 */
  readonly firstFailureAt?: string
  /** 最近一次失败时刻。 */
  readonly lastFailureAt?: string
  /** 最近一次失败通知时刻（24h 窗口起点）。 */
  readonly lastNotifiedAt?: string
  /** 最近一次失败分类。 */
  readonly lastFailureKind?: TaskFailureKind
  /** 最近一次失败原因（截断后的可读文本）。 */
  readonly lastFailureReason?: string
  /** 最近一次成功时刻。 */
  readonly lastSuccessAt?: string
}

/** 调度状态文件结构。 */
export interface SchedulerState {
  readonly version: typeof STATE_VERSION
  readonly tasks: Readonly<Record<string, TaskFailureState>>
}

/** 派生视图：失败状态 + 任务 id + 下次可通知时刻。 */
export interface TaskStatus extends TaskFailureState {
  readonly taskId: string
  /**
   * 下次可通知时刻（ISO 8601 带偏移）。
   *
   * `undefined` 表示**当前即可通知**：没有失败，或本轮失败尚未通知过。
   */
  readonly nextNotifyAt?: string
}

/** 日志出口：兼容统一门面与简单回调。 */
export type StateStoreLogger =
  | { warn(message: string, meta?: unknown): void }
  | ((message: string) => void)

/** {@link StateStore} 构造选项。 */
export interface StateStoreOptions {
  /** 状态文件绝对路径（默认应为 `<workspace>/.agent-base/state/scheduler.json`）。 */
  readonly path: string
  /** 日志出口。 */
  readonly logger?: StateStoreLogger
  /** 时钟（测试注入，禁止真实 sleep）。 */
  readonly clock?: Clock
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * 把时刻格式化为带时区偏移的 ISO 8601（秒精度，毫秒省略）。
 *
 * 用**进程本地偏移**：状态不绑定任何业务时区，只记录绝对时刻；偏移信息让
 * 人工排查时无需换算，`Date.parse` 也能原样还原。
 */
export function formatIsoWithOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

/** 默认状态文件路径：`<workspace>/.agent-base/state/scheduler.json`。 */
export function defaultStatePath(workspace: string): string {
  return join(workspace, '.agent-base', 'state', 'scheduler.json')
}

function warnOf(logger: StateStoreLogger | undefined): (message: string) => void {
  if (logger === undefined) return () => {}
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FAILURE_KINDS: readonly TaskFailureKind[] = [
  'missing',
  'runtime',
  'exec',
  'parse',
  'deliver',
]

function isFailureKind(value: unknown): value is TaskFailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value)
}

/** 可选 ISO 字符串字段：类型 / 可解析性校验通过后返回它（或 `undefined`）。 */
function isoField(raw: unknown): { ok: boolean; value?: string } {
  if (raw === undefined) return { ok: true }
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) return { ok: false }
  return { ok: true, value: raw }
}

function emptyState(): SchedulerState {
  return { version: STATE_VERSION, tasks: {} }
}

/** 校验单条任务状态；任何字段不符都返回 `undefined`（整文件按损坏处理）。 */
function parseTaskState(raw: unknown): TaskFailureState | undefined {
  if (!isRecord(raw)) return undefined
  const failures = raw.consecutiveFailures
  if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) return undefined
  if (raw.lastFailureKind !== undefined && !isFailureKind(raw.lastFailureKind)) return undefined
  if (raw.lastFailureReason !== undefined && typeof raw.lastFailureReason !== 'string') {
    return undefined
  }

  const firstFailureAt = isoField(raw.firstFailureAt)
  const lastFailureAt = isoField(raw.lastFailureAt)
  const lastNotifiedAt = isoField(raw.lastNotifiedAt)
  const lastSuccessAt = isoField(raw.lastSuccessAt)
  if (!firstFailureAt.ok || !lastFailureAt.ok || !lastNotifiedAt.ok || !lastSuccessAt.ok) {
    return undefined
  }

  return {
    consecutiveFailures: failures,
    ...(firstFailureAt.value === undefined ? {} : { firstFailureAt: firstFailureAt.value }),
    ...(lastFailureAt.value === undefined ? {} : { lastFailureAt: lastFailureAt.value }),
    ...(lastNotifiedAt.value === undefined ? {} : { lastNotifiedAt: lastNotifiedAt.value }),
    ...(raw.lastFailureKind === undefined ? {} : { lastFailureKind: raw.lastFailureKind }),
    ...(raw.lastFailureReason === undefined
      ? {}
      : { lastFailureReason: raw.lastFailureReason as string }),
    ...(lastSuccessAt.value === undefined ? {} : { lastSuccessAt: lastSuccessAt.value }),
  }
}

/** 校验整个状态文件；版本 / 结构任一不符返回 `undefined`。 */
function parseState(raw: unknown): SchedulerState | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.version !== STATE_VERSION) return undefined
  if (!isRecord(raw.tasks)) return undefined
  const tasks: Record<string, TaskFailureState> = {}
  for (const [taskId, value] of Object.entries(raw.tasks)) {
    if (!TASK_ID_PATTERN.test(taskId)) return undefined
    const entry = parseTaskState(value)
    if (entry === undefined) return undefined
    tasks[taskId] = entry
  }
  return { version: STATE_VERSION, tasks }
}

function nextNotifyAtOf(entry: TaskFailureState): string | undefined {
  if (entry.consecutiveFailures === 0) return undefined
  if (entry.lastNotifiedAt === undefined) return undefined
  const last = Date.parse(entry.lastNotifiedAt)
  if (Number.isNaN(last)) return undefined
  return formatIsoWithOffset(new Date(last + FAILURE_NOTIFY_INTERVAL_MS))
}

function statusOf(taskId: string, entry: TaskFailureState): TaskStatus {
  const nextNotifyAt = nextNotifyAtOf(entry)
  return {
    taskId,
    ...entry,
    ...(nextNotifyAt === undefined ? {} : { nextNotifyAt }),
  }
}

/**
 * 调度状态存储。
 *
 * **一致性策略**：不做跨调用内存缓存——每次读取都以磁盘为准，每次写入都在
 * 「重新解析磁盘结果」的基础上合并。这样多实例（或重启后的新实例）永远看到
 * 最新窗口，且不会用内存脏值覆盖别人写入的状态。状态文件很小，这点 I/O
 * 相对一次任务执行可以忽略。
 */
export class StateStore {
  /** 状态文件绝对路径。 */
  readonly path: string
  private readonly warn: (message: string) => void
  private readonly clock: Clock

  constructor(options: StateStoreOptions) {
    if (typeof options.path !== 'string' || options.path.trim() === '') {
      throw new TypeError('[scheduler/state] path 必须是非空字符串')
    }
    this.path = options.path
    this.warn = warnOf(options.logger)
    this.clock = options.clock ?? { now: () => new Date() }
  }

  /**
   * 读取状态。
   *
   * 文件不存在 / JSON 损坏 / 结构非法 / version 不符 → 空状态 + warn，不抛。
   */
  read(): SchedulerState {
    if (!existsSync(this.path)) return emptyState()
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      this.warn(
        `调度状态文件 ${this.path} 读取失败，按空状态处理：${error instanceof Error ? error.message : String(error)}`,
      )
      return emptyState()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.warn(`调度状态文件 ${this.path} 不是合法 JSON，按空状态处理`)
      return emptyState()
    }
    const state = parseState(parsed)
    if (state === undefined) {
      this.warn(`调度状态文件 ${this.path} 结构非法或版本不兼容，按空状态处理`)
      return emptyState()
    }
    return state
  }

  /** 单个任务的失败状态；不存在返回 `undefined`。 */
  get(taskId: string): TaskFailureState | undefined {
    assertTaskId(taskId)
    return this.read().tasks[taskId]
  }

  /** 派生视图（含 `nextNotifyAt`）。 */
  status(taskId: string): TaskStatus {
    assertTaskId(taskId)
    const entry = this.read().tasks[taskId] ?? { consecutiveFailures: 0 }
    return statusOf(taskId, entry)
  }

  /**
   * 记录一次失败并持久化，返回最新状态。
   *
   * `firstFailureAt` 只在失败链起点写入；`lastNotifiedAt` 属于通知窗口，
   * 与失败计数分开维护，这里原样保留。
   */
  recordFailure(
    taskId: string,
    failure: { readonly kind: TaskFailureKind; readonly reason: string; readonly at: Date },
  ): TaskStatus {
    assertTaskId(taskId)
    const current = this.read()
    const prev = current.tasks[taskId]
    const at = formatIsoWithOffset(failure.at)
    const next: TaskFailureState = {
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      firstFailureAt: prev?.firstFailureAt ?? at,
      lastFailureAt: at,
      lastFailureKind: failure.kind,
      lastFailureReason: failure.reason,
      ...(prev?.lastNotifiedAt === undefined ? {} : { lastNotifiedAt: prev.lastNotifiedAt }),
      ...(prev?.lastSuccessAt === undefined ? {} : { lastSuccessAt: prev.lastSuccessAt }),
    }
    this.write({ ...current, tasks: { ...current.tasks, [taskId]: next } })
    return statusOf(taskId, next)
  }

  /**
   * 是否允许发送失败通知（**闭区间**：恰好 24h 算可通知）。
   *
   * 没有失败记录 / 从未通知过 → `true`。
   */
  shouldNotify(taskId: string, now: Date = this.clock.now()): boolean {
    assertTaskId(taskId)
    const entry = this.read().tasks[taskId]
    if (entry === undefined || entry.lastNotifiedAt === undefined) return true
    const last = Date.parse(entry.lastNotifiedAt)
    if (Number.isNaN(last)) return true
    return now.getTime() - last >= FAILURE_NOTIFY_INTERVAL_MS
  }

  /** 记录「已发过失败通知」，窗口重新计时。 */
  markNotified(taskId: string, now: Date = this.clock.now()): TaskStatus {
    assertTaskId(taskId)
    const current = this.read()
    const prev = current.tasks[taskId] ?? { consecutiveFailures: 0 }
    const next: TaskFailureState = { ...prev, lastNotifiedAt: formatIsoWithOffset(now) }
    this.write({ ...current, tasks: { ...current.tasks, [taskId]: next } })
    return statusOf(taskId, next)
  }

  /**
   * 记录一次成功：失败计数清零、清空失败链字段、写 `lastSuccessAt`。
   *
   * **`lastNotifiedAt` 刻意保留**：D12 约束是「每任务 24h 最多一条通知」，
   * 这是对通知频率的硬上限，与失败链是否结束无关。若成功时清除，则
   * 「失败→通知→成功→再失败」会在 24h 内发出第二条通知，违反上限。
   */
  recordSuccess(taskId: string, now: Date = this.clock.now()): TaskStatus {
    assertTaskId(taskId)
    const current = this.read()
    const prev = current.tasks[taskId]
    const next: TaskFailureState = {
      consecutiveFailures: 0,
      lastSuccessAt: formatIsoWithOffset(now),
      ...(prev?.lastNotifiedAt === undefined ? {} : { lastNotifiedAt: prev.lastNotifiedAt }),
    }
    this.write({ ...current, tasks: { ...current.tasks, [taskId]: next } })
    return statusOf(taskId, next)
  }

  /** 原子写（tmp → rename）；失败只 warn，绝不抛。 */
  private write(state: SchedulerState): void {
    let tmp: string | undefined
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      tmp = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.path)
    } catch (error) {
      if (tmp !== undefined) rmSync(tmp, { force: true })
      this.warn(
        `调度状态写入失败（已忽略，沿用内存结果）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/** 创建状态存储。 */
export function createStateStore(options: StateStoreOptions): StateStore {
  return new StateStore(options)
}
