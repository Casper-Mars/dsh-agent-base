/**
 * cron 边界与反例。
 *
 * 从 dsh-rsi-agent 的 `tests/log-cron-edge.spec.ts` 中**只提取 cron 相关用例**，
 * 去掉 log retention / redact 依赖与目录夹具。覆盖：
 *   - `*\/100` 步长大于字段范围；
 *   - `7` 与 `0` 同为周日；
 *   - `SUN-SAT` 名称区间；
 *   - 前导零；
 *   - 6 段（含秒）拒绝；
 *   - DOM/DOW 同时受限时取更早者。
 */
import { describe, expect, it } from 'vitest'
import { next, parseCron } from '../src/scheduler/cron.js'

describe('cron · 边界与反例', () => {
  it('步长大于字段范围（*/100）→ 只命中起点 0', () => {
    const schedule = parseCron('*/100 * * * *')
    expect(schedule.minute.values).toEqual([0])
  })

  it('周字段 `7` 与 `0` 等价（都表示周日）', () => {
    expect(parseCron('0 0 * * 7').dayOfWeek.values).toEqual([0])
    expect(parseCron('0 0 * * 0').dayOfWeek.values).toEqual([0])
  })

  it('`SUN-SAT` 名称区间合法且命中 0..6', () => {
    expect(parseCron('0 0 * * SUN-SAT').dayOfWeek.values).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('前导零（`05`）按十进制解析', () => {
    expect(parseCron('05 09 * * *').minute.values).toEqual([5])
    expect(parseCron('05 09 * * *').hour.values).toEqual([9])
  })

  it('6 段（含秒）→ 拒绝（最小粒度是分钟）', () => {
    expect(() => parseCron('0 0 9 * * *')).toThrow(/5 段/)
  })

  it('日/周同时受限时从周六推进到「周日或 1 号」中更早者', () => {
    // 2026-10-24 是周六 00:00Z；`0 0 1 * 0` 表示「每月 1 号或每周日」。
    const from = new Date(Date.UTC(2026, 9, 24, 0, 0, 0))
    const result = next(parseCron('0 0 1 * 0'), from, 'UTC')
    // 下一个周日是 2026-10-25，早于 11-01。
    expect(result.toISOString()).toBe('2026-10-25T00:00:00.000Z')
  })
})
