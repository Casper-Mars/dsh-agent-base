/**
 * 文本任务渲染：7 个占位符（含时区）/ 未知占位符 / 字素截断 / 摘要。
 *
 * 固定 `now`，不读系统时钟；断言按不同时区各验一组。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_DELIVER_CHARS,
  SUMMARY_MAX,
  deriveSummary,
  renderText,
  splitGraphemes,
  truncateText,
} from '../src/scheduler/text.js'

/** 2026-11-06 09:00 Asia/Shanghai = 2026-11-05 20:00 America/New_York（EST）。 */
const NOW = new Date('2026-11-06T09:00:00+08:00')
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'

function render(template: string, timezone = 'Asia/Shanghai', maxChars?: number): string {
  return renderText(template, {
    taskId: 'demo',
    timezone,
    now: NOW,
    ...(maxChars === undefined ? {} : { maxChars }),
  })
}

describe('占位符 · Asia/Shanghai', () => {
  it('{{date}} / {{time}} / {{datetime}}', () => {
    expect(render('{{date}}')).toBe('2026-11-06')
    expect(render('{{time}}')).toBe('09:00')
    expect(render('{{datetime}}')).toBe('2026-11-06 09:00')
  })

  it('{{iso}} 带真实时区偏移', () => {
    expect(render('{{iso}}')).toBe('2026-11-06T09:00:00+08:00')
  })

  it('{{weekday}} / {{timezone}} / {{task_id}}', () => {
    expect(render('{{weekday}}')).toBe('周五')
    expect(render('{{timezone}}')).toBe('Asia/Shanghai')
    expect(render('{{task_id}}')).toBe('demo')
  })

  it('全部占位符可同时出现在一句里', () => {
    expect(render('[{{task_id}}] {{date}} {{time}} {{weekday}} ({{timezone}})')).toBe(
      '[demo] 2026-11-06 09:00 周五 (Asia/Shanghai)',
    )
  })
})

describe('占位符 · America/New_York', () => {
  it('按传入时区计算日期 / 时间 / 星期', () => {
    expect(render('{{date}}', 'America/New_York')).toBe('2026-11-05')
    expect(render('{{time}}', 'America/New_York')).toBe('20:00')
    expect(render('{{weekday}}', 'America/New_York')).toBe('周四')
  })

  it('{{iso}} 偏移为 -05:00（EST）', () => {
    expect(render('{{iso}}', 'America/New_York')).toBe('2026-11-05T20:00:00-05:00')
  })

  it('同一时刻在不同时区渲染出不同墙钟', () => {
    expect(render('{{datetime}}', 'UTC')).toBe('2026-11-06 01:00')
  })
})

describe('占位符 · 边界', () => {
  it('未知占位符原样保留', () => {
    expect(render('{{unknown}} {{date}}')).toBe('{{unknown}} 2026-11-06')
    expect(render('{{ date }}')).toBe('{{ date }}')
  })

  it('单次替换，不递归展开', () => {
    // taskId 本身是占位符文本：展开后不得再被当作模板处理。
    expect(
      renderText('{{task_id}}', {
        taskId: '{{time}}',
        timezone: 'Asia/Shanghai',
        now: NOW,
      }),
    ).toBe('{{time}}')
  })

  it('没有占位符时原样返回', () => {
    expect(render('早上好')).toBe('早上好')
  })
})

describe('字素截断', () => {
  it('不超预算原样返回', () => {
    expect(truncateText('hello', 10)).toBe('hello')
  })

  it('超预算按字素截断（ASCII）', () => {
    expect(truncateText('a'.repeat(10), 4)).toBe('aaaa')
  })

  it('预算 <= 0 → 空串', () => {
    expect(truncateText('abc', 0)).toBe('')
    expect(truncateText('abc', -1)).toBe('')
  })

  it('不切半个 emoji（代理对）', () => {
    const text = '😀'.repeat(100)
    const result = truncateText(text, 3)
    expect(result).toBe('😀'.repeat(3))
    expect(splitGraphemes(result)).toHaveLength(3)
  })

  it('不拆 ZWJ 组合 emoji', () => {
    expect(truncateText(FAMILY.repeat(3), 2)).toBe(FAMILY.repeat(2))
    expect(splitGraphemes(FAMILY)).toEqual([FAMILY])
  })

  it('先展开占位符再截断', () => {
    expect(render('{{date}}', 'Asia/Shanghai', 4)).toBe('2026')
    expect(render('{{task_id}}', 'Asia/Shanghai', 6)).toBe('demo')
  })

  it('默认预算 4000', () => {
    expect(DEFAULT_MAX_DELIVER_CHARS).toBe(4000)
    expect(render('x'.repeat(5000))).toHaveLength(4000)
  })
})

describe('摘要', () => {
  it('取首个非空行并 trim', () => {
    expect(deriveSummary('\n\n  第一行  \n第二行')).toBe('第一行')
  })

  it('上限 120 字素', () => {
    expect(SUMMARY_MAX).toBe(120)
    expect(splitGraphemes(deriveSummary('a'.repeat(500)))).toHaveLength(120)
    expect(splitGraphemes(deriveSummary(FAMILY.repeat(200)))).toHaveLength(120)
  })

  it('空文本回退为通用文案', () => {
    expect(deriveSummary('')).toBe('定时任务通知')
    expect(deriveSummary('   \n\t ')).toBe('定时任务通知')
  })
})
