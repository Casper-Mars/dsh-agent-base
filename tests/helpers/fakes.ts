/**
 * 测试替身：假时钟 / 假定时器 / 假投递 / 假执行器。
 *
 * 全部同步推进，**不真实 sleep、不起子进程**；`advance` 在每次回调后让出一个
 * 宏任务，保证 runTask 内部的 promise 链结算完毕再继续推进。
 */
import { vi } from 'vitest'
import type {
  Clock,
  DeliveryInput,
  DeliveryResult,
  DeliveryTarget,
  ExecResult,
  ExecStrategy,
  TaskDef,
  Timer,
  TimerHandle,
} from '../../src/scheduler/types.js'
import type { TaskDeliveryPort } from '../../src/scheduler/task.js'
import type { TaskStore } from '../../src/scheduler/store.js'

/** 让出宏任务：把已排队的微任务全部排空。 */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

/** 可手动推进的时钟。 */
export class FakeClock implements Clock {
  private ms: number

  constructor(iso = '2026-01-01T00:00:00.000Z') {
    this.ms = Date.parse(iso)
  }

  now(): Date {
    return new Date(this.ms)
  }

  set(ms: number): void {
    this.ms = ms
  }

  advance(ms: number): void {
    this.ms += ms
  }
}

interface FakeTimerEntry {
  readonly id: number
  readonly at: number
  readonly cb: () => void
}

/** 与注入时钟联动的假定时器。 */
export class FakeTimer implements Timer {
  private seq = 0
  private entries: FakeTimerEntry[] = []

  constructor(private readonly clock: FakeClock) {}

  setTimer(delayMs: number, cb: () => void): TimerHandle {
    const id = (this.seq += 1)
    this.entries.push({ id, at: this.clock.now().getTime() + Math.max(delayMs, 0), cb })
    return id as unknown as TimerHandle
  }

  clearTimer(handle: TimerHandle): void {
    const id = handle as unknown as number
    this.entries = this.entries.filter((entry) => entry.id !== id)
  }

  /** 未结算的定时器数量。 */
  get pending(): number {
    return this.entries.length
  }

  /** 当前排定的目标时刻（毫秒，升序）。 */
  get schedule(): number[] {
    return this.entries.map((entry) => entry.at).sort((a, b) => a - b)
  }

  /** 推进时钟并依次触发所有到点定时器（含回调中新装的）。 */
  async advance(ms: number): Promise<void> {
    const target = this.clock.now().getTime() + ms
    for (let guard = 0; guard < 10_000; guard += 1) {
      const due = this.entries
        .filter((entry) => entry.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (due === undefined) break
      this.entries = this.entries.filter((entry) => entry !== due)
      this.clock.set(Math.max(due.at, this.clock.now().getTime()))
      due.cb()
      await flush()
    }
    this.clock.set(target)
    await flush()
  }
}

/** 日志收集器（info / warn / error 全部进同一个数组）。 */
export interface CapturedLogger {
  readonly lines: string[]
  readonly logger: {
    info(message: string, meta?: unknown): void
    warn(message: string, meta?: unknown): void
    error(message: string, meta?: unknown): void
  }
}

export function captureLogger(): CapturedLogger {
  const lines: string[] = []
  const push = (message: string): void => {
    lines.push(message)
  }
  return { lines, logger: { info: push, warn: push, error: push } }
}

/** 投递替身：默认目标 main、投递成功、失败通知成功。 */
export interface DeliveryHarness {
  readonly port: TaskDeliveryPort
  readonly resolveTarget: ReturnType<typeof vi.fn>
  readonly deliver: ReturnType<typeof vi.fn>
  readonly deliverNotice: ReturnType<typeof vi.fn>
  readonly inputs: DeliveryInput[]
}

export function createDelivery(
  options: {
    readonly target?: DeliveryTarget
    readonly deliver?: (input: DeliveryInput) => Promise<DeliveryResult>
    readonly deliverNotice?: (input: DeliveryInput) => Promise<DeliveryResult>
  } = {},
): DeliveryHarness {
  const inputs: DeliveryInput[] = []
  const resolveTarget = vi.fn(async (): Promise<DeliveryTarget> => options.target ?? { sessionId: 'main' })
  const deliver = vi.fn(async (input: DeliveryInput): Promise<DeliveryResult> => {
    inputs.push(input)
    return options.deliver === undefined ? 'delivered' : options.deliver(input)
  })
  const deliverNotice = vi.fn(async (input: DeliveryInput): Promise<DeliveryResult> => {
    inputs.push(input)
    return options.deliverNotice === undefined ? 'delivered' : options.deliverNotice(input)
  })
  return {
    port: { resolveTarget, deliver, deliverNotice } as TaskDeliveryPort,
    resolveTarget,
    deliver,
    deliverNotice,
    inputs,
  }
}

/** 执行结果默认值（成功且无唤醒）。 */
export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: '{"shouldWake":false}\n',
    stderr: '',
    truncated: false,
    timedOut: false,
    ...overrides,
  }
}

/** 执行替身：每次调用返回同一结果（或由 `next` 决定）。 */
export interface ExecHarness {
  readonly exec: ExecStrategy
  readonly calls: Array<{ scriptPath: string; cwd: string }>
}

export function createExec(
  result: Partial<ExecResult> | (() => Partial<ExecResult>) = {},
): ExecHarness {
  const calls: Array<{ scriptPath: string; cwd: string }> = []
  return {
    calls,
    exec: {
      name: 'fake',
      async exec(input) {
        calls.push({ scriptPath: input.scriptPath, cwd: input.cwd })
        return execResult(typeof result === 'function' ? result() : result)
      },
    },
  }
}

/** 任务清单替身（`TaskStore` 结构兼容）。 */
export interface StoreHarness {
  readonly store: Pick<TaskStore, 'list' | 'get'>
  readonly list: ReturnType<typeof vi.fn>
  readonly get: ReturnType<typeof vi.fn>
}

export function createStore(
  tasks: readonly TaskDef[],
  options: { readonly corrupted?: readonly string[]; readonly throwOnList?: boolean } = {},
): StoreHarness {
  const list = vi.fn(() => {
    if (options.throwOnList === true) throw new Error('清单损坏')
    return { tasks: [...tasks], corrupted: [...(options.corrupted ?? [])] }
  })
  const get = vi.fn((id: string): TaskDef | undefined => tasks.find((task) => task.id === id))
  return { store: { list, get }, list, get }
}

/**
 * 统计型定时器包装：记录「活跃句柄数」与 `setTimer` / `clearTimer` 次数。
 *
 * 用于验证调度器的两条硬不变量：
 *   - 任意时刻每任务至多一条 timer（`maxActive` 不得超过任务数）；
 *   - `stop` / `reload` 后旧代际不再重装 timer（`setCalls` 不再增长）。
 */
export class CountingTimer implements Timer {
  /** `setTimer` 调用次数。 */
  setCalls = 0
  /** `clearTimer` 调用次数。 */
  clearCalls = 0
  /** 观测到的最大同时活跃句柄数。 */
  maxActive = 0

  private readonly active = new Set<TimerHandle>()

  constructor(private readonly inner: Timer) {}

  setTimer(delayMs: number, cb: () => void): TimerHandle {
    this.setCalls += 1
    const box: { handle?: TimerHandle } = {}
    const handle = this.inner.setTimer(delayMs, () => {
      if (box.handle !== undefined) this.active.delete(box.handle)
      cb()
    })
    box.handle = handle
    this.active.add(handle)
    if (this.active.size > this.maxActive) this.maxActive = this.active.size
    return handle
  }

  clearTimer(handle: TimerHandle): void {
    this.clearCalls += 1
    this.active.delete(handle)
    this.inner.clearTimer(handle)
  }

  /** 当前活跃句柄数（== 未结算的 timer 数）。 */
  get pending(): number {
    return this.active.size
  }
}
