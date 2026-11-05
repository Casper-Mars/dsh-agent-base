/**
 * 调度状态：连续失败 / 24h 通知窗口 / 成功清零 / 损坏降级 / 重启后窗口生效。
 *
 * 全部用注入时钟，禁止真实 sleep。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FAILURE_NOTIFY_INTERVAL_MS,
  STATE_VERSION,
  StateStore,
  defaultStatePath,
} from '../src/scheduler/state.js'

const roots: string[] = []

function tempState(): { dir: string; path: string; warnings: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-base-state-'))
  roots.push(dir)
  return { dir, path: join(dir, 'scheduler.json'), warnings: [] }
}

function store(
  path: string,
  warnings: string[] = [],
  clock?: { now(): Date },
): StateStore {
  return new StateStore({
    path,
    logger: { warn: (message) => warnings.push(message) },
    ...(clock === undefined ? {} : { clock }),
  })
}

const T0 = new Date('2026-11-06T09:00:00+08:00')
const HOUR = 60 * 60 * 1000

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('常量与路径', () => {
  it('版本号为 1，通知窗口为 24h', () => {
    expect(STATE_VERSION).toBe(1)
    expect(FAILURE_NOTIFY_INTERVAL_MS).toBe(24 * HOUR)
  })

  it('默认路径为 <workspace>/.agent-base/state/scheduler.json', () => {
    expect(defaultStatePath('/w')).toBe('/w/.agent-base/state/scheduler.json')
  })
})

describe('记录失败', () => {
  it('首次失败：建文件、计数 1、写首次 / 最近失败与分类', () => {
    const { path } = tempState()
    const state = store(path)
    const status = state.recordFailure('demo', { kind: 'exec', reason: '退出码 1', at: T0 })

    expect(status.consecutiveFailures).toBe(1)
    expect(status.firstFailureAt).toBeDefined()
    expect(status.lastFailureAt).toBe(status.firstFailureAt)
    expect(status.lastFailureKind).toBe('exec')
    expect(status.lastFailureReason).toBe('退出码 1')
    expect(existsSync(path)).toBe(true)

    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      tasks: Record<string, { consecutiveFailures: number }>
    }
    expect(raw.version).toBe(STATE_VERSION)
    expect(raw.tasks.demo?.consecutiveFailures).toBe(1)
  })

  it('连续失败累计，firstFailureAt 保持不变', () => {
    const { path } = tempState()
    const state = store(path)
    const first = state.recordFailure('demo', { kind: 'exec', reason: 'a', at: T0 })
    const second = state.recordFailure('demo', { kind: 'parse', reason: 'b', at: at(HOUR) })

    expect(second.consecutiveFailures).toBe(2)
    expect(second.firstFailureAt).toBe(first.firstFailureAt)
    expect(second.lastFailureAt).not.toBe(first.firstFailureAt)
    expect(second.lastFailureKind).toBe('parse')
  })

  it('首次失败时即可通知，nextNotifyAt 为 undefined', () => {
    const { path } = tempState()
    const state = store(path)
    const status = state.recordFailure('demo', { kind: 'missing', reason: 'x', at: T0 })
    expect(state.shouldNotify('demo', T0)).toBe(true)
    expect(status.nextNotifyAt).toBeUndefined()
  })
})

describe('24h 通知窗口', () => {
  it('窗口内不重复通知', () => {
    const { path } = tempState()
    const state = store(path)
    state.recordFailure('demo', { kind: 'exec', reason: 'x', at: T0 })
    state.markNotified('demo', T0)

    expect(state.shouldNotify('demo', at(HOUR))).toBe(false)
    expect(state.shouldNotify('demo', at(24 * HOUR - 1))).toBe(false)
    expect(state.status('demo').nextNotifyAt).toBeDefined()
  })

  it('恰好 24h 算可通知（闭区间）', () => {
    const { path } = tempState()
    const state = store(path)
    state.recordFailure('demo', { kind: 'exec', reason: 'x', at: T0 })
    state.markNotified('demo', T0)
    expect(state.shouldNotify('demo', at(24 * HOUR))).toBe(true)
  })

  it('超过 24h 可通知', () => {
    const { path } = tempState()
    const state = store(path)
    state.recordFailure('demo', { kind: 'exec', reason: 'x', at: T0 })
    state.markNotified('demo', T0)
    expect(state.shouldNotify('demo', at(25 * HOUR))).toBe(true)
  })

  it('markNotified 后窗口重新计时', () => {
    const { path } = tempState()
    const state = store(path)
    state.recordFailure('demo', { kind: 'exec', reason: 'x', at: T0 })
    state.markNotified('demo', T0)
    state.markNotified('demo', at(24 * HOUR))

    expect(state.shouldNotify('demo', at(30 * HOUR))).toBe(false)
    expect(state.shouldNotify('demo', at(48 * HOUR))).toBe(true)
  })

  it('未记录失败的任务默认可通知', () => {
    const { path } = tempState()
    expect(store(path).shouldNotify('ghost', T0)).toBe(true)
  })
})

describe('记录成功', () => {
  it('清零失败链并写 lastSuccessAt', () => {
    const { path } = tempState()
    const state = store(path)
    state.recordFailure('demo', { kind: 'exec', reason: 'a', at: T0 })
    state.recordFailure('demo', { kind: 'exec', reason: 'b', at: at(HOUR) })
    const status = state.recordSuccess('demo', at(2 * HOUR))

    expect(status.consecutiveFailures).toBe(0)
    expect(status.firstFailureAt).toBeUndefined()
    expect(status.lastFailureAt).toBeUndefined()
    expect(status.lastFailureKind).toBeUndefined()
    expect(status.lastFailureReason).toBeUndefined()
    expect(status.lastSuccessAt).toBeDefined()

    const reloaded = store(path).get('demo')
    expect(reloaded?.consecutiveFailures).toBe(0)
    expect(reloaded?.lastSuccessAt).toBe(status.lastSuccessAt)
  })

  it('保留 lastNotifiedAt：24h 上限与失败链是否结束无关', () => {
    const { path } = tempState()
    const state = store(path)
    state.recordFailure('demo', { kind: 'exec', reason: 'a', at: T0 })
    state.markNotified('demo', T0)
    const status = state.recordSuccess('demo', at(HOUR))

    expect(status.lastNotifiedAt).toBeDefined()
    // 成功后立刻再失败：窗口未过，仍不得发第二条通知（D12 硬上限）。
    state.recordFailure('demo', { kind: 'exec', reason: 'b', at: at(2 * HOUR) })
    expect(state.shouldNotify('demo', at(2 * HOUR))).toBe(false)
    expect(state.shouldNotify('demo', at(24 * HOUR))).toBe(true)
  })

  it('成功后再失败重新从 1 计数', () => {
    const { path } = tempState()
    const state = store(path)
    state.recordFailure('demo', { kind: 'exec', reason: 'a', at: T0 })
    state.recordFailure('demo', { kind: 'exec', reason: 'b', at: at(HOUR) })
    state.recordSuccess('demo', at(2 * HOUR))
    const status = state.recordFailure('demo', { kind: 'parse', reason: 'c', at: at(3 * HOUR) })
    expect(status.consecutiveFailures).toBe(1)
    expect(status.firstFailureAt).toBeDefined()
  })
})

describe('重启 / 多实例', () => {
  it('实例 A 写 → 实例 B 读：24h 窗口仍生效', () => {
    const { path } = tempState()
    const a = store(path)
    a.recordFailure('demo', { kind: 'exec', reason: 'x', at: T0 })
    a.markNotified('demo', T0)

    const b = store(path)
    expect(b.shouldNotify('demo', at(HOUR))).toBe(false)
    expect(b.get('demo')?.consecutiveFailures).toBe(1)
    expect(b.status('demo').lastNotifiedAt).toBeDefined()
  })

  it('两个实例交替写入不会互相覆盖丢计数', () => {
    const { path } = tempState()
    const a = store(path)
    const b = store(path)
    a.recordFailure('demo', { kind: 'exec', reason: 'a', at: T0 })
    b.recordFailure('demo', { kind: 'exec', reason: 'b', at: at(HOUR) })
    expect(a.status('demo').consecutiveFailures).toBe(2)
  })
})

describe('损坏降级', () => {
  it('文件不存在 → 空状态', () => {
    const { path } = tempState()
    expect(store(path).read()).toEqual({ version: STATE_VERSION, tasks: {} })
  })

  it('JSON 损坏 → 空状态 + warn，不抛', () => {
    const { path, warnings } = tempState()
    writeFileSync(path, '{ not json', 'utf8')
    const state = store(path, warnings)
    expect(() => state.read()).not.toThrow()
    expect(state.read()).toEqual({ version: STATE_VERSION, tasks: {} })
    expect(warnings.join('\n')).toMatch(/不是合法 JSON/)
  })

  it('版本不符 / 结构非法 → 空状态 + warn', () => {
    const { path, warnings } = tempState()
    writeFileSync(path, JSON.stringify({ version: 99, tasks: {} }), 'utf8')
    const state = store(path, warnings)
    expect(state.read()).toEqual({ version: STATE_VERSION, tasks: {} })
    expect(warnings.join('\n')).toMatch(/结构非法或版本不兼容/)

    writeFileSync(
      path,
      JSON.stringify({ version: 1, tasks: { demo: { consecutiveFailures: 'x' } } }),
      'utf8',
    )
    expect(state.read()).toEqual({ version: STATE_VERSION, tasks: {} })
  })

  it('损坏后写入会重建合法文件', () => {
    const { path } = tempState()
    writeFileSync(path, 'broken', 'utf8')
    const warnings: string[] = []
    store(path, warnings).recordFailure('demo', { kind: 'exec', reason: 'x', at: T0 })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version: number }
    expect(raw.version).toBe(STATE_VERSION)
  })
})

describe('原子写', () => {
  it('写入后目录只有状态文件，无 tmp 残留', () => {
    const { dir, path } = tempState()
    const state = store(path)
    state.recordFailure('demo', { kind: 'exec', reason: 'x', at: T0 })
    state.markNotified('demo', T0)
    state.recordSuccess('demo', at(HOUR))
    expect(readdirSync(dir)).toEqual(['scheduler.json'])
  })

  it('写失败只 warn（不抛），状态仍可读', () => {
    const { path, warnings } = tempState()
    // 父路径是普通文件 → mkdir 必失败，写入被降级。
    const blocked = join(path, 'nested', 'scheduler.json')
    writeFileSync(path, 'x', 'utf8')
    const state = store(blocked, warnings)
    expect(() =>
      state.recordFailure('demo', { kind: 'exec', reason: 'x', at: T0 }),
    ).not.toThrow()
    expect(warnings.join('\n')).toMatch(/写入失败/)
  })
})
