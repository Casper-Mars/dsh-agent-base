/**
 * 文本任务渲染（技术方案 §4.2 占位符 / §5.1 职责划分）。
 *
 * 三件事，全部是纯函数（时间来自入参 `now`，时区来自入参 `timezone`）：
 *   1. {@link renderText}：展开 7 个占位符，再按**字素簇**截断到正文预算；
 *   2. {@link truncateText}：字素安全截断，绝不切半个 emoji / ZWJ 组合；
 *   3. {@link deriveSummary}：首行非空摘要（notice 形态用，≤120 字素）。
 *
 * 时区语义：占位符一律按**传入的时区**计算，而不是进程本地时区。调度器的
 * cron 已按配置时区触发，正文里的日期必须与触发时区一致，否则跨时区部署时
 * 会出现「9 点触发、正文写 1 点」的错位。
 *
 * 本模块不追加任何领域声明（disclaimer）——base 没有领域知识，合规声明属于
 * 领域包自己的投递逻辑。
 */
import { localParts } from './cron.js'

/** 单条投递正文的默认字素预算。 */
export const DEFAULT_MAX_DELIVER_CHARS = 4000

/** 摘要字素上限。 */
export const SUMMARY_MAX = 120

/** 摘要为空时的兜底文案（不带领域语义）。 */
const EMPTY_SUMMARY_FALLBACK = '定时任务通知'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string }>
}

const graphemeSegmenter: SegmenterLike | undefined =
  typeof (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => SegmenterLike })
    .Segmenter === 'function'
    ? new (
        Intl as unknown as {
          Segmenter: new (locale?: string, options?: { granularity: string }) => SegmenterLike
        }
      ).Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

/** 把文本切成字素簇（`Intl.Segmenter` 不可用时退回码点，仍不会切代理对）。 */
export function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter !== undefined) {
    const units: string[] = []
    for (const item of graphemeSegmenter.segment(text)) units.push(item.segment)
    return units
  }
  return Array.from(text)
}

/**
 * 按**字素簇**截断到至多 `max` 个单位。
 *
 * 用码点（`Array.from`）已经不切代理对；用字素簇进一步避免把 `👨‍👩‍👧` 这类
 * ZWJ 组合切成半个家庭 emoji。
 */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return ''
  const units = splitGraphemes(text)
  if (units.length <= max) return text
  return units.slice(0, max).join('')
}

/** {@link renderText} 入参。 */
export interface RenderTextOptions {
  /** 任务 id（`{{task_id}}`）。 */
  readonly taskId: string
  /** IANA 时区名（占位符按此时区计算）。 */
  readonly timezone: string
  /** 渲染时刻（注入，禁止读全局时钟）。 */
  readonly now: Date
  /** 字素预算，默认 {@link DEFAULT_MAX_DELIVER_CHARS}。 */
  readonly maxChars?: number
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

const secondFormatters = new Map<string, Intl.DateTimeFormat>()

/** 目标时区下的「秒」（`localParts` 不暴露秒，这里补一个缓存 formatter）。 */
function secondOf(timezone: string, epochMs: number): number {
  let formatter = secondFormatters.get(timezone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      second: '2-digit',
      hourCycle: 'h23',
    })
    secondFormatters.set(timezone, formatter)
  }
  const found = formatter.formatToParts(new Date(epochMs)).find((part) => part.type === 'second')
  return found === undefined ? 0 : Number(found.value)
}

interface WallClock {
  readonly date: string
  readonly time: string
  readonly iso: string
  readonly weekday: string
}

/** 目标时区下的墙钟分解 + 带偏移 ISO。 */
function wallClockOf(timezone: string, now: Date): WallClock {
  const epochMs = now.getTime()
  // 秒以下对墙钟无意义，先截到秒再算偏移（localParts 只到秒）。
  const secondMs = Math.floor(epochMs / 1000) * 1000
  const parts = localParts(timezone, secondMs)
  const second = secondOf(timezone, secondMs)
  const date = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
  const time = `${pad2(parts.hour)}:${pad2(parts.minute)}`
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    second,
  )
  const offsetMinutes = Math.round((naive - secondMs) / 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  const iso = `${date}T${time}:${pad2(second)}${offset}`
  return { date, time, iso, weekday: WEEKDAYS[parts.dayOfWeek] ?? '' }
}

/**
 * 展开文本任务占位符（§4.2 的 7 个）。
 *
 *   `{{date}}` `{{time}}` `{{datetime}}` `{{iso}}`
 *   `{{weekday}}` `{{timezone}}` `{{task_id}}`
 *
 * 规则：
 *   - 全部按 `timezone` 的墙钟计算（`{{iso}}` 带该时刻的真实偏移）；
 *   - **未知占位符原样保留**（用户写错时能一眼看出来，而不是被静默吞掉）；
 *   - **单次替换**：占位符值里若出现 `{{...}}` 也不会再展开（无递归注入风险）；
 *   - 先展开、后按 `maxChars`（默认 4000）字素截断。
 */
export function renderText(template: string, options: RenderTextOptions): string {
  const clock = wallClockOf(options.timezone, options.now)
  const values: Record<string, string> = {
    date: clock.date,
    time: clock.time,
    datetime: `${clock.date} ${clock.time}`,
    iso: clock.iso,
    weekday: clock.weekday,
    timezone: options.timezone,
    task_id: options.taskId,
  }
  const expanded = template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  )
  return truncateText(expanded, options.maxChars ?? DEFAULT_MAX_DELIVER_CHARS)
}

/** 从正文派生一行摘要（首行非空、trim、≤ {@link SUMMARY_MAX} 字素）。 */
export function deriveSummary(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return truncateText(firstLine ?? EMPTY_SUMMARY_FALLBACK, SUMMARY_MAX)
}
