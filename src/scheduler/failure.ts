/**
 * 失败归类、失败通知文案与 24h 通知窗口状态机（技术方案 D12 / §4.5）。
 *
 * 三条硬规则：
 *   1. **五类失败**（missing / runtime / exec / parse / deliver）各有可读阶段文案，
 *      通知与日志使用同一套描述，避免「日志说一种、通知说另一种」；
 *   2. **每任务 24h 至多一条失败通知**：窗口状态由 {@link StateStore} 维护，
 *      这里只负责「记账 → 判断 → 投递 → 标记」的顺序；
 *   3. **恢复不产生消息**：成功只清失败状态（{@link processSuccess}），
 *      绝不投递「已恢复」之类文本。
 *
 * 投递边界（关键取舍）：
 *   - `deliverNotice` 返回 `false` 或抛错时**不 markNotified**——窗口未被消耗，
 *     下一次失败仍可重试；本函数**绝不抛异常**，错误通过返回值 `error` 表达。
 *   - 投递成功后才 `markNotified`，把窗口起点记为**本次失败时刻**（而非投递
 *     完成时刻），保证窗口与失败链的记账使用同一时间基准。
 *
 * 时间渲染：通知里的所有时刻都按调用方传入的 `timezone` 渲染成带偏移的
 * ISO 8601，**绝不读进程本地时区**——cron 按任务时区触发，正文必须一致。
 */
import { join } from 'node:path'
import { localParts } from './cron.js'
import { FAILURE_NOTIFY_INTERVAL_MS } from './state.js'
import type { TaskStatus } from './state.js'
import { DEFAULT_TASKS_SUBDIR } from './store.js'
import type { TaskDef, TaskFailureKind } from './types.js'

/** 已知失败分类（顺序即文档顺序）。 */
const FAILURE_KINDS: readonly TaskFailureKind[] = [
  'missing',
  'runtime',
  'exec',
  'parse',
  'deliver',
]

/** 五类失败 → 可读阶段文案。 */
const FAILURE_PHASES: Readonly<Record<TaskFailureKind, string>> = Object.freeze({
  missing: '任务程序不可用（缺失 / 非普通文件 / 不可读）',
  runtime: '运行时不可用（路径形态 / 扩展名不受支持）',
  exec: '任务执行失败（非零退出 / 崩溃 / 超时 / 输出超限）',
  parse: '结果解析失败（stdout 末行不是合法结果 JSON）',
  deliver: '结果投递失败',
})

/**
 * 失败归类文案。
 *
 * @param kind   五类失败之一。
 * @param detail 可选补充（错误码 / exitCode / stderr 摘要）。
 * @returns `阶段：原因` 形式的一行文本；`detail` 为空时只返回阶段。
 */
export function describeFailure(kind: TaskFailureKind, detail?: string): string {
  const phase = FAILURE_PHASES[kind] ?? '任务失败'
  const extra = detail?.trim()
  return extra === undefined || extra === '' ? phase : `${phase}：${extra}`
}

/** 日志出口：`{info,warn}` 对象或单函数（两者都当作同一出口）。 */
export type FailureLogger =
  | {
      info?(message: string, meta?: unknown): void
      warn?(message: string, meta?: unknown): void
    }
  | ((message: string) => void)

interface NormalizedLogger {
  readonly info: (message: string) => void
  readonly warn: (message: string) => void
}

/** 归一化日志出口；未注入时全部为无操作。 */
function loggerOf(logger: FailureLogger | undefined): NormalizedLogger {
  if (logger === undefined) return { info: () => {}, warn: () => {} }
  if (typeof logger === 'function') return { info: logger, warn: logger }
  return {
    info: (message) => logger.info?.(message),
    warn: (message) => logger.warn?.(message),
  }
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

const secondFormatters = new Map<string, Intl.DateTimeFormat>()

/** 目标时区下的「秒」（`localParts` 只到分钟，这里补一个缓存 formatter）。 */
function secondInZone(timezone: string, epochMs: number): number {
  let formatter = secondFormatters.get(timezone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      second: '2-digit',
      hourCycle: 'h23',
    })
    secondFormatters.set(timezone, formatter)
  }
  const found = formatter
    .formatToParts(new Date(epochMs))
    .find((part) => part.type === 'second')
  return found === undefined ? 0 : Number(found.value)
}

/**
 * 把绝对时刻渲染为**目标时区**的 ISO 8601（带真实偏移，秒精度）。
 *
 * 偏移由「墙钟按 UTC 读」与真实时间戳的差推出，跨夏令时也成立。
 */
export function formatInTimeZone(date: Date, timezone: string): string {
  const epochMs = date.getTime()
  const secondMs = Math.floor(epochMs / 1000) * 1000
  const parts = localParts(timezone, secondMs)
  const second = secondInZone(timezone, secondMs)
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, second)
  const offsetMinutes = Math.round((naive - secondMs) / 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(second)}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

/** 任务类型（`kind` 缺省即 script）。 */
function taskKindOf(task: TaskDef): 'script' | 'text' {
  return task.kind === 'text' ? 'text' : 'script'
}

/** {@link buildFailureNotice} 入参。 */
export interface FailureNoticeInput {
  /** 失败的任务定义。 */
  readonly task: TaskDef
  /** 失败分类。 */
  readonly failureKind: TaskFailureKind
  /** 失败补充细节（可读）。 */
  readonly detail?: string
  /** 失败状态（连续次数 / 首次 / 最近）。 */
  readonly status: Pick<
    TaskStatus,
    'consecutiveFailures' | 'firstFailureAt' | 'lastFailureAt'
  >
  /** 任务时区（通知里的时刻按它渲染）。 */
  readonly timezone: string
  /** 下次最早可通知时刻（窗口起点 + 24h）。 */
  readonly nextNotifyAt: Date
  /** 任务定义目录（**相对 workspace**），缺省 `.agent-base/tasks`。 */
  readonly tasksDir?: string
  /** 任务程序的解析后绝对路径（仅 script；缺省用任务定义里的 `task_path`）。 */
  readonly scriptPath?: string
}

/** 渲染不存在的时刻（首次 / 最近失败缺失时）。 */
const ABSENT_TIME = '—'

/**
 * 生成失败通知文案（方案 §4.5）。
 *
 * 多行纯文本，字段固定、顺序稳定，便于用户扫读与测试断言：
 *
 * ```text
 * 【定时任务失败】示例任务（demo）
 * 类型：script
 * 阶段：任务执行失败（…）
 * 原因：进程异常退出（exitCode=1）
 * 连续失败：3 次（首次 2026-11-06T09:00:00+08:00 / 最近 2026-11-08T09:00:00+08:00）
 * 下次最早通知：2026-11-09T09:00:00+08:00
 * 任务定义：.agent-base/tasks/demo.json
 * 任务程序：/abs/path/task.mjs
 * ```
 */
export function buildFailureNotice(input: FailureNoticeInput): string {
  const { task, status, timezone } = input
  const kind = taskKindOf(task)
  const tasksDir = input.tasksDir ?? DEFAULT_TASKS_SUBDIR
  const definitionPath = join(tasksDir, `${task.id}.json`)

  const firstAt =
    status.firstFailureAt === undefined
      ? ABSENT_TIME
      : formatInTimeZone(new Date(status.firstFailureAt), timezone)
  const lastAt =
    status.lastFailureAt === undefined
      ? ABSENT_TIME
      : formatInTimeZone(new Date(status.lastFailureAt), timezone)

  const lines: string[] = [
    `【定时任务失败】${task.name}（${task.id}）`,
    `类型：${kind}`,
    `阶段：${describeFailure(input.failureKind)}`,
  ]

  const detail = input.detail?.trim()
  if (detail !== undefined && detail !== '') lines.push(`原因：${detail}`)

  lines.push(
    `连续失败：${status.consecutiveFailures} 次（首次 ${firstAt} / 最近 ${lastAt}）`,
    `下次最早通知：${formatInTimeZone(input.nextNotifyAt, timezone)}`,
    `任务定义：${definitionPath}`,
  )

  if (task.kind !== 'text') {
    const scriptPath = input.scriptPath ?? task.task_path
    lines.push(`任务程序：${scriptPath}`)
  }

  return lines.join('\n')
}

/** 失败状态机依赖的状态端口（`StateStore` 结构兼容）。 */
export interface FailureStatePort {
  recordFailure(
    taskId: string,
    failure: { readonly kind: TaskFailureKind; readonly reason: string; readonly at: Date },
  ): TaskStatus
  shouldNotify(taskId: string, now?: Date): boolean
  markNotified(taskId: string, now?: Date): TaskStatus
}

/** {@link processFailure} 入参。 */
export interface ProcessFailureDeps {
  /** 状态存储（真实实现为 `StateStore`）。 */
  readonly state: FailureStatePort
  /** 本次失败时刻（注入，禁止读全局时钟）。 */
  readonly now: Date
  /** 失败通知投递；返回 `true` 表示已投递。 */
  readonly deliverNotice: (text: string) => Promise<boolean>
  /** 任务时区（通知文案按它渲染）。 */
  readonly timezone: string
  /** 任务定义目录（相对 workspace），缺省 `.agent-base/tasks`。 */
  readonly tasksDir?: string
  /** 任务程序绝对路径（可选，通知里展示）。 */
  readonly scriptPath?: string
  /** 日志出口，默认无操作。 */
  readonly logger?: FailureLogger
}

/** {@link processFailure} 结果。 */
export interface ProcessFailureResult {
  /** 记账后的最新失败状态。 */
  readonly status: TaskStatus
  /** 本次是否成功投递了失败通知。 */
  readonly notified: boolean
  /** 已生成的通知正文（投递失败时也存在，便于调用方诊断）。 */
  readonly notice?: string
  /** 投递失败原因（`notified === false` 且已尝试投递时存在）。 */
  readonly error?: string
}

/** 本次失败入参（分类 + 细节）。 */
export interface TaskFailureInput {
  readonly kind: TaskFailureKind
  readonly detail?: string
}

/**
 * 处理一次任务失败：记账 → 窗口判断 → 生成通知 → 投递 → 标记。
 *
 * 顺序不可交换：
 *   1. `recordFailure` 先把计数与时刻落盘（即使后续投递失败，计数也不能丢）；
 *   2. `shouldNotify === false` → 只写日志，**不投递**（24h 窗口未到期）；
 *   3. 投递成功才 `markNotified`；投递失败 / 抛错 → 不标记（下次仍可通知），
 *      错误信息放进返回值，**绝不向外抛**。
 *
 * @param task   任务定义。
 * @param failure 失败分类与细节。
 * @param deps    状态、时刻、投递与日志出口。
 */
export async function processFailure(
  task: TaskDef,
  failure: TaskFailureInput,
  deps: ProcessFailureDeps,
): Promise<ProcessFailureResult> {
  const log = loggerOf(deps.logger)
  const reason = describeFailure(failure.kind, failure.detail)

  let status: TaskStatus
  try {
    status = deps.state.recordFailure(task.id, {
      kind: failure.kind,
      reason,
      at: deps.now,
    })
  } catch (error) {
    // 状态写失败不应打断调度：用内存视图兜底，通知仍然按「首次失败」生成。
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`任务 ${task.id} 失败状态写入异常（继续处理通知）：${message}`)
    status = {
      taskId: task.id,
      consecutiveFailures: 1,
      firstFailureAt: deps.now.toISOString(),
      lastFailureAt: deps.now.toISOString(),
      lastFailureKind: failure.kind,
      lastFailureReason: reason,
    }
  }

  let allowed = true
  try {
    allowed = deps.state.shouldNotify(task.id, deps.now)
  } catch (error) {
    // 窗口判断失败按「允许通知」处理：宁可多一条，不可静默吞掉故障。
    log.warn(
      `任务 ${task.id} 通知窗口判断异常（按可通知处理）：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (!allowed) {
    log.info(`任务 ${task.id} 失败通知在 24h 窗口内，跳过投递（连续失败 ${status.consecutiveFailures} 次）`)
    return { status, notified: false }
  }

  const notice = buildFailureNotice({
    task,
    failureKind: failure.kind,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    status,
    timezone: deps.timezone,
    nextNotifyAt: new Date(deps.now.getTime() + FAILURE_NOTIFY_INTERVAL_MS),
    ...(deps.tasksDir === undefined ? {} : { tasksDir: deps.tasksDir }),
    ...(deps.scriptPath === undefined ? {} : { scriptPath: deps.scriptPath }),
  })

  let delivered = false
  let deliverError: string | undefined
  try {
    delivered = await deps.deliverNotice(notice)
    if (!delivered) deliverError = '失败通知投递被拒绝（deliverNotice 返回 false）'
  } catch (error) {
    deliverError = error instanceof Error ? error.message : String(error)
  }

  if (!delivered) {
    // 关键：不 markNotified。窗口未被消耗，下一次失败会再次尝试投递。
    log.warn(`任务 ${task.id} 失败通知投递失败：${deliverError ?? '未知原因'}`)
    return {
      status,
      notified: false,
      notice,
      error: deliverError ?? '失败通知投递失败',
    }
  }

  let attempted = status
  try {
    attempted = deps.state.markNotified(task.id, deps.now)
  } catch (error) {
    // 已投递但窗口记账失败：仍报告 notified:true；下一次可能重复通知一次，
    // 这是「宁可重复一条也不静默丢故障」的取舍。
    log.warn(
      `任务 ${task.id} 失败通知已投递，但窗口记账失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  log.info(`任务 ${task.id} 失败通知已投递（连续失败 ${attempted.consecutiveFailures} 次）`)
  return { status: attempted, notified: true, notice }
}

/** {@link processSuccess} 入参。 */
export interface ProcessSuccessDeps {
  /** 状态存储（只用到 `recordSuccess`）。 */
  readonly state: { recordSuccess(taskId: string, now?: Date): TaskStatus }
  /** 本次成功时刻（注入）。 */
  readonly now: Date
  /** 日志出口，默认无操作。 */
  readonly logger?: FailureLogger
}

/**
 * 处理一次任务成功：失败计数清零。
 *
 * **恢复不产生消息**——本函数不接收任何投递端口，也不返回任何文本。
 * 成功是「静默」的：用户只会在失败时收到一条通知，恢复后由下一条正常结果
 * 自然体现，避免「失败 / 恢复」两条消息互相刷屏。
 */
export function processSuccess(taskId: string, deps: ProcessSuccessDeps): void {
  const log = loggerOf(deps.logger)
  try {
    deps.state.recordSuccess(taskId, deps.now)
  } catch (error) {
    log.warn(
      `任务 ${taskId} 成功状态写入异常（已忽略）：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/** 导出失败分类清单（诊断 / 文档用）。 */
export const KNOWN_FAILURE_KINDS: readonly TaskFailureKind[] = FAILURE_KINDS
