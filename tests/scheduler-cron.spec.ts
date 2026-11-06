/**
 * 5 段 cron 解析 / 下一触发时刻。
 *
 * 从 dsh-rsi-agent 的 `tests/scheduler-cron.spec.ts` 移植：
 *   - 删除 `resolveTimezone` 相关 import 与「时区优先级」describe
 *     （base 没有 runtime 模块，时区优先级属于后续配置装配任务）；
 *   - 其余用例全部保留，并补一条 DST 空洞用例（春季跳表时 02:xx 不存在）。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_CANDIDATES,
  isValidCron,
  localParts,
  next as nextCronTime,
  parseCron,
} from '../src/scheduler/cron.js'

const at = (iso: string): Date => new Date(iso)

describe('cron · 解析', () => {
  it('5 段通配：分/时全范围，日/月/周未限制', () => {
    const schedule = parseCron('* * * * *')
    expect(schedule.minute.values).toHaveLength(60)
    expect(schedule.hour.values).toHaveLength(24)
    expect(schedule.dayOfMonth.restricted).toBe(false)
    expect(schedule.dayOfWeek.restricted).toBe(false)
  })

  it('步进写法 `*/15` 命中 0/15/30/45', () => {
    expect(parseCron('*/15 * * * *').minute.values).toEqual([0, 15, 30, 45])
  })

  it('裸步进 `5/20`：从 5 到字段上界每 20 取一个', () => {
    expect(parseCron('5/20 * * * *').minute.values).toEqual([5, 25, 45])
  })

  it('裸步进 `0/15`：从 0 起每 15 分钟', () => {
    expect(parseCron('0/15 * * * *').minute.values).toEqual([0, 15, 30, 45])
    expect(nextCronTime(parseCron('0/15 * * * *'), at('2026-01-01T00:07:00Z'), 'UTC').toISOString()).toBe(
      '2026-01-01T00:15:00.000Z',
    )
  })

  it('裸步进 `5/20` 在 next 中按实际命中值推进', () => {
    const schedule = parseCron('5/20 * * * *')
    expect(nextCronTime(schedule, at('2026-01-01T00:06:00Z'), 'UTC').toISOString()).toBe(
      '2026-01-01T00:25:00.000Z',
    )
  })

  it('区间 + 步进 `9-17/2`', () => {
    expect(parseCron('0 9-17/2 * * *').hour.values).toEqual([9, 11, 13, 15, 17])
  })

  it('枚举与区间混合', () => {
    expect(parseCron('0,30 8-10 * * *').minute.values).toEqual([0, 30])
  })

  it('月份英文缩写', () => {
    expect(parseCron('0 0 1 JAN *').month.values).toEqual([1])
  })

  it('星期英文缩写与 7=周日归一化', () => {
    const schedule = parseCron('0 0 * * SUN')
    expect(schedule.dayOfWeek.values).toEqual([0])
    expect(parseCron('0 0 * * 7').dayOfWeek.values).toEqual([0])
  })

  it('`?` 仅允许用于日/周字段', () => {
    expect(() => parseCron('0 0 ? * *')).not.toThrow()
    expect(() => parseCron('? * * * *')).toThrow(/分/)
  })

  it('段数不是 5 → 报错并给出实际段数', () => {
    expect(() => parseCron('* * * *')).toThrow(/实际 4 段/)
    expect(() => parseCron('* * * * * *')).toThrow(/实际 6 段/)
  })

  it('空表达式 → 报错', () => {
    expect(() => parseCron('   ')).toThrow(/空表达式/)
  })

  it('取值越界 → 报错', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/超出范围/)
    expect(() => parseCron('* 24 * * *')).toThrow(/超出范围/)
    expect(() => parseCron('* * 0 * *')).toThrow(/超出范围/)
  })

  it('步长为 0 → 报错', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/步长/)
  })

  it('区间起点大于终点 → 报错', () => {
    expect(() => parseCron('0 17-9 * * *')).toThrow(/起点大于终点/)
  })

  it('isValidCron 不抛异常', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true)
    expect(isValidCron('bad')).toBe(false)
  })
})

describe('cron · next（时区感知）', () => {
  it('UTC：每分钟触发，返回严格大于 from 的下一分钟', () => {
    const schedule = parseCron('* * * * *')
    expect(nextCronTime(schedule, at('2026-01-01T00:00:30Z'), 'UTC').toISOString()).toBe(
      '2026-01-01T00:01:00.000Z',
    )
  })

  it('UTC：整点分钟精确命中时也严格向后推进', () => {
    const schedule = parseCron('0 * * * *')
    expect(nextCronTime(schedule, at('2026-01-01T00:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-01-01T01:00:00.000Z',
    )
  })

  it('Asia/Shanghai：每天 09:00 对应 01:00Z', () => {
    const schedule = parseCron('0 9 * * *')
    expect(nextCronTime(schedule, at('2026-01-01T00:30:00Z'), 'Asia/Shanghai').toISOString()).toBe(
      '2026-01-01T01:00:00.000Z',
    )
  })

  it('同一表达式在不同时区得到不同时刻', () => {
    const schedule = parseCron('0 9 * * *')
    const from = at('2026-01-01T00:00:00Z')
    const utc = nextCronTime(schedule, from, 'UTC')
    const shanghai = nextCronTime(schedule, from, 'Asia/Shanghai')
    expect(utc.toISOString()).toBe('2026-01-01T09:00:00.000Z')
    expect(shanghai.toISOString()).toBe('2026-01-01T01:00:00.000Z')
  })

  it('DST 空洞：America/New_York 春季 02:30 不存在 → 顺延到次日 02:30', () => {
    // 2026-03-08 02:00 EST 直接跳到 03:00 EDT，当地不存在 02:xx 墙钟时刻。
    // from = 2026-03-08T05:00Z（当地 00:00 EST），下一次 02:30 应是 03-09 02:30 EDT（06:30Z）。
    const schedule = parseCron('30 2 * * *')
    expect(
      nextCronTime(schedule, at('2026-03-08T05:00:00Z'), 'America/New_York').toISOString(),
    ).toBe('2026-03-09T06:30:00.000Z')
  })

  it('跨日推进：23:59 之后到次日 00:00', () => {
    const schedule = parseCron('0 0 * * *')
    expect(nextCronTime(schedule, at('2026-03-01T23:59:00Z'), 'UTC').toISOString()).toBe(
      '2026-03-02T00:00:00.000Z',
    )
  })

  it('跨月推进：月末到下月 1 日', () => {
    const schedule = parseCron('0 0 1 * *')
    expect(nextCronTime(schedule, at('2026-01-31T12:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    )
  })

  it('周字段：从周四推进到下周一', () => {
    const schedule = parseCron('0 0 * * 1')
    expect(nextCronTime(schedule, at('2026-01-01T12:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-01-05T00:00:00.000Z',
    )
  })

  it('日/周同时受限取「或」语义', () => {
    // 2026-01-01 是周四；`1` 号（DOM）或周一（DOW）都应命中 → 次日 1/2 不命中，
    // 但 1/5 是周一，1/1 之后最近的 1 号是 2/1。
    const schedule = parseCron('0 0 1 * 1')
    expect(nextCronTime(schedule, at('2026-01-02T00:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-01-05T00:00:00.000Z',
    )
  })

  it('每年 2 月 29 日：从 2026 推进到 2028 闰日', () => {
    const schedule = parseCron('0 0 29 2 *')
    expect(nextCronTime(schedule, at('2026-03-01T00:00:00Z'), 'UTC').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    )
  })

  it('永不命中的表达式（2 月 31 日）→ 在搜索上限内抛错', () => {
    const schedule = parseCron('0 0 31 2 *')
    expect(() => nextCronTime(schedule, at('2026-01-01T00:00:00Z'), 'UTC')).toThrow(/搜索上限/)
  })

  it('搜索上限是显式有界常量（防止退化成无界循环）', () => {
    expect(MAX_CANDIDATES).toBe(500_000)
    expect(Number.isInteger(MAX_CANDIDATES)).toBe(true)
    expect(MAX_CANDIDATES).toBeGreaterThan(10_000)
  })

  it('localParts 返回目标时区墙钟与星期', () => {
    const parts = localParts('Asia/Shanghai', Date.parse('2026-01-04T16:30:00Z'))
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 5, hour: 0, minute: 30 })
    expect(parts.dayOfWeek).toBe(1)
  })

  it('非法时区 → 抛错（Intl 拒绝）', () => {
    const schedule = parseCron('* * * * *')
    expect(() => nextCronTime(schedule, at('2026-01-01T00:00:00Z'), 'Not/AZone')).toThrow()
  })
})
