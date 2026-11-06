/**
 * `guardedLoggerMethod` 的实参透传契约。
 *
 * 背景：`logger-console` 用 `util.format` 拼接实参，若在 `meta === undefined`
 * 时仍传第二参，每条日志末尾会多出 ` undefined`。因此这里锁定：
 *   - 无 meta → 只传 1 个实参；
 *   - 有 meta → 原样传 2 个实参；
 *   - 非函数 → 无操作；方法抛错 → 被吞掉。
 */
import { describe, expect, it, vi } from 'vitest'
import { guardedLoggerMethod } from '../src/scheduler/mount.js'

describe('guardedLoggerMethod', () => {
  it('无 meta 的 info / warn 调用只收到 1 个实参', () => {
    const calls: unknown[][] = []
    const receiver = {
      info: (...args: unknown[]) => calls.push(args),
      warn: (...args: unknown[]) => calls.push(args),
    }

    guardedLoggerMethod(receiver.info, receiver)('无 meta 的 info')
    guardedLoggerMethod(receiver.warn, receiver)('无 meta 的 warn')

    expect(calls).toEqual([['无 meta 的 info'], ['无 meta 的 warn']])
    for (const call of calls) expect(call).toHaveLength(1)
  })

  it('有 meta 时才传第二参，且 receiver 绑定正确', () => {
    const calls: unknown[][] = []
    const receiver = {
      level: 'warn',
      warn(this: { level: string }, ...args: unknown[]) {
        calls.push([this.level, ...args])
      },
    }

    guardedLoggerMethod(receiver.warn, receiver)('带 meta 的 warn', { taskId: 'demo' })

    expect(calls).toEqual([['warn', '带 meta 的 warn', { taskId: 'demo' }]])
  })

  it('非函数退化为无操作', () => {
    const noop = guardedLoggerMethod(undefined, undefined)
    expect(() => noop('任意消息')).not.toThrow()
    expect(() => noop('任意消息', { a: 1 })).not.toThrow()
  })

  it('日志方法自身抛错被隔离', () => {
    const boom = guardedLoggerMethod(() => {
      throw new Error('boom')
    }, undefined)
    expect(() => boom('消息')).not.toThrow()
  })

  it('console 兜底：console.warn 收到的实参不含多余的 undefined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      guardedLoggerMethod(console.warn, console)('只有消息')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})
