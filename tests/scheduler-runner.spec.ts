/**
 * runner：末行 JSON 解析 / 有界 stdout（UTF-8 字节）/ stderr 上限 / 超时强杀 /
 * spawn 失败。全部使用 **fake spawn**，不启动真实子进程，也不真实 sleep。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
  KILL_GRACE_MS,
  STDOUT_TRUNCATION_MARKER,
  createNodeExecStrategy,
  parseTaskOutput,
  truncationDetail,
} from '../src/scheduler/runner.js'
import type { ExecInput } from '../src/scheduler/types.js'

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  signals: string[]
  kill(signal: string): boolean
}

/** 构造 fake 子进程：`SIGKILL` 时自动发 `close`，模拟真实进程被杀后的收尾。 */
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.signals = []
  child.kill = (signal: string) => {
    child.signals.push(signal)
    if (signal === 'SIGKILL') child.emit('close', null, signal)
    return true
  }
  return child
}

interface SpawnCapture {
  readonly command: string
  readonly args: readonly string[]
  readonly options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown }
}

function harness(child: FakeChild): {
  strategy: ReturnType<typeof createNodeExecStrategy>
  calls: SpawnCapture[]
} {
  const calls: SpawnCapture[] = []
  const spawnFn = ((command: string, args: readonly string[], options: SpawnCapture['options']) => {
    calls.push({ command, args, options })
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { strategy: createNodeExecStrategy({ spawn: spawnFn }), calls }
}

const INPUT: ExecInput = {
  scriptPath: '/workspace/tasks/job.mjs',
  cwd: '/workspace/tasks',
  timeoutMs: 5000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
}

describe('runner · 常量与诊断文本', () => {
  it('默认超时 60s、stdout 1 MiB、stderr 64 KiB、强杀宽限 500ms', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(60_000)
    expect(DEFAULT_MAX_STDOUT_BYTES).toBe(1_048_576)
    expect(DEFAULT_MAX_STDERR_BYTES).toBe(65_536)
    expect(KILL_GRACE_MS).toBe(500)
    expect(STDOUT_TRUNCATION_MARKER).toContain('truncated')
  })

  it('truncationDetail 带字节上限', () => {
    expect(truncationDetail(1234)).toContain('1234')
    expect(truncationDetail(1234)).toContain('截断')
  })
})

describe('runner · 执行策略（fake spawn）', () => {
  it('以 node <scriptPath> 启动，cwd 与 env 透传，正常退出', async () => {
    const child = fakeChild()
    const { strategy, calls } = harness(child)
    const promise = strategy.exec(INPUT)

    child.stdout.emit('data', Buffer.from('log line\n{"shouldWake":false}\n'))
    child.emit('close', 0, null)

    const result = await promise
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'log line\n{"shouldWake":false}\n',
      stderr: '',
      truncated: false,
      timedOut: false,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(process.execPath)
    expect(calls[0]?.args).toEqual([INPUT.scriptPath])
    expect(calls[0]?.options.cwd).toBe(INPUT.cwd)
    expect(calls[0]?.options.env).toEqual({ ...process.env })
  })

  it('非零退出码如实返回', async () => {
    const child = fakeChild()
    const { strategy } = harness(child)
    const promise = strategy.exec(INPUT)
    child.stderr.emit('data', Buffer.from('boom'))
    child.emit('close', 7, null)

    const result = await promise
    expect(result.exitCode).toBe(7)
    expect(result.stderr).toBe('boom')
    expect(parseTaskOutput(result.stdout)).toBeNull()
  })

  it('spawn 同步抛错 → spawnError（不 reject）', async () => {
    const spawnFn = (() => {
      throw new Error('EACCES')
    }) as unknown as typeof import('node:child_process').spawn
    const strategy = createNodeExecStrategy({ spawn: spawnFn })
    await expect(strategy.exec(INPUT)).resolves.toMatchObject({ spawnError: 'EACCES' })
  })

  it('error 事件 → spawnError（不 reject）', async () => {
    const child = fakeChild()
    const { strategy } = harness(child)
    const promise = strategy.exec(INPUT)
    child.emit('error', new Error('ENOENT'))

    const result = await promise
    expect(result.spawnError).toBe('ENOENT')
    expect(result.exitCode).toBeNull()
  })

  it('超时：SIGTERM → 宽限后 SIGKILL，timedOut 为 true', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const { strategy } = harness(child)
      const promise = strategy.exec({ ...INPUT, timeoutMs: 1000 })

      vi.advanceTimersByTime(1000)
      expect(child.signals).toEqual(['SIGTERM'])
      expect(child.listenerCount('close')).toBe(1)

      vi.advanceTimersByTime(500)
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])

      const result = await promise
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runner · stdout 按 UTF-8 字节有界', () => {
  it('超限即截断、标记并强杀，缓冲不超过上限', async () => {
    const child = fakeChild()
    const { strategy } = harness(child)
    const promise = strategy.exec({ ...INPUT, maxStdoutBytes: 10 })

    child.stdout.emit('data', Buffer.from('中'.repeat(10))) // 30 字节
    const result = await promise

    expect(result.truncated).toBe(true)
    expect(result.stdout).toBe('中'.repeat(3)) // 只收 9 字节，第 4 个字符整块丢弃
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(10)
    expect(result.stdout.includes('\uFFFD')).toBe(false)
    expect(child.signals).toEqual(['SIGKILL'])
  })

  it('ASCII 大块 + 多字节混合：按字节计数（按字符计数会漏杀）', async () => {
    const child = fakeChild()
    const { strategy } = harness(child)
    // 90 个 ASCII 字节 + 10 个汉字（30 字节）：共 120 字节，但只有 100 个字符。
    // 若实现按「字符数」计数，100 <= 100 就不会触发截断（M4 变异存活）。
    const promise = strategy.exec({ ...INPUT, maxStdoutBytes: 100 })
    child.stdout.emit('data', Buffer.from(`${'a'.repeat(90)}${'中'.repeat(10)}`, 'utf8'))

    const result = await promise
    expect(result.truncated).toBe(true)
    expect(child.signals).toEqual(['SIGKILL'])
    // 90 + 3 个汉字（9 字节）= 99 字节；第 4 个汉字只放得下 1 字节，整块丢弃。
    expect(result.stdout).toBe(`${'a'.repeat(90)}${'中'.repeat(3)}`)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(100)
    expect(result.stdout.includes('\uFFFD')).toBe(false)
  })

  it('跨 chunk 的多字节字符不被切半（StringDecoder）', async () => {
    const child = fakeChild()
    const { strategy } = harness(child)
    const promise = strategy.exec(INPUT)
    const bytes = Buffer.from('中文', 'utf8')

    child.stdout.emit('data', bytes.subarray(0, 4)) // 「中」+「文」的首字节
    child.stdout.emit('data', bytes.subarray(4))
    child.emit('close', 0, null)

    const result = await promise
    expect(result.stdout).toBe('中文')
    expect(result.truncated).toBe(false)
  })

  it('截断点落在多字节中间时不产生替换符', async () => {
    const child = fakeChild()
    const { strategy } = harness(child)
    const promise = strategy.exec({ ...INPUT, maxStdoutBytes: 4 })
    child.stdout.emit('data', Buffer.from('😀', 'utf8')) // 4 字节，正好放得下
    child.emit('close', 0, null)

    expect((await promise).stdout).toBe('😀')

    const child2 = fakeChild()
    const second = harness(child2)
    const promise2 = second.strategy.exec({ ...INPUT, maxStdoutBytes: 3 })
    child2.stdout.emit('data', Buffer.from('😀', 'utf8')) // 只放得下 3 字节 → 整块丢弃
    const result2 = await promise2
    expect(result2.truncated).toBe(true)
    expect(result2.stdout).toBe('')
  })
})

describe('runner · stderr 有界', () => {
  it('按字节截断到上限', async () => {
    const child = fakeChild()
    const { strategy } = harness(child)
    const promise = strategy.exec({ ...INPUT, maxStderrBytes: 5 })
    child.stderr.emit('data', Buffer.from('abcdefgh'))
    child.stderr.emit('data', Buffer.from('ij'))
    child.emit('close', 1, null)

    const result = await promise
    expect(result.stderr).toBe('abcde')
  })
})

describe('runner · parseTaskOutput', () => {
  it('取最后一个非空行（忽略日志行与尾随空行）', () => {
    expect(parseTaskOutput('log\n{"shouldWake":false}\n\n  \n')).toEqual({ shouldWake: false })
  })

  it('唤醒分支保留 data 原文', () => {
    expect(parseTaskOutput('{"shouldWake":true,"data":"你好\\n世界"}')).toEqual({
      shouldWake: true,
      data: '你好\n世界',
    })
  })

  it('多行干扰：只要末行合法就成功', () => {
    expect(parseTaskOutput('{"bad":1}\nnot-json\n{"shouldWake":false}')).toEqual({
      shouldWake: false,
    })
  })

  it('末行非法 JSON / 空输出 / 全空白 → null', () => {
    expect(parseTaskOutput('{"shouldWake":false}\nnot-json')).toBeNull()
    expect(parseTaskOutput('')).toBeNull()
    expect(parseTaskOutput('\n \n\t')).toBeNull()
  })

  it('数组 / 标量 / shouldWake 非 boolean → null', () => {
    expect(parseTaskOutput('[1,2]')).toBeNull()
    expect(parseTaskOutput('42')).toBeNull()
    expect(parseTaskOutput('"x"')).toBeNull()
    expect(parseTaskOutput('{"shouldWake":"yes"}')).toBeNull()
    expect(parseTaskOutput('{"data":"x"}')).toBeNull()
  })

  it('shouldWake=true 但 data 非 string → null', () => {
    expect(parseTaskOutput('{"shouldWake":true}')).toBeNull()
    expect(parseTaskOutput('{"shouldWake":true,"data":1}')).toBeNull()
    expect(parseTaskOutput('{"shouldWake":true,"data":null}')).toBeNull()
  })

  it('shouldWake=false 时不要求 data', () => {
    expect(parseTaskOutput('{"shouldWake":false,"data":"ignored"}')).toEqual({
      shouldWake: false,
    })
  })
})
