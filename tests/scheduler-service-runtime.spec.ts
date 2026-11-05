/**
 * `SchedulerService` 运行时补测：重点打 timer 不变量与代际守卫。
 *
 * 覆盖重点怀疑点：
 *   - `fireOnce` 立即 `arm` + `finally` 再 `arm`：两次重装之间无双 timer、无丢失；
 *   - 超长延时（> 2^31-1ms）被截断后，提前醒来只重装、不执行；
 *   - `reload()` 保留单飞锁；重载移除任务后，旧 fire 不得复活 timer；
 *   - `stop()` 后旧 fire 的 `finally` 不再重装 timer（用 setTimer 计数证明）；
 *   - `runNow` 与定时触发共用单飞锁。
 *
 * 全程 fake timer + 假时钟 + 假投递：不真实 sleep、不起子进程。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SchedulerService } from '../src/scheduler/service.js'
import { createStateStore } from '../src/scheduler/state.js'
import type { StateStore } from '../src/scheduler/state.js'
import type { TaskStore } from '../src/scheduler/store.js'
import type {
  DeliveryResult,
  ScriptTaskDef,
  TaskDef,
  TaskRunOutcome,
  TextTaskDef,
} from '../src/scheduler/types.js'
import {
  CountingTimer,
  FakeClock,
  FakeTimer,
  captureLogger,
  createDelivery,
  createExec,
  createStore,
  flush,
  type CapturedLogger,
  type DeliveryHarness,
  type ExecHarness,
} from './helpers/fakes.js'

/** `setTimeout` 最大延时（与服务实现一致，用于构造超长延时场景）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

const tempDirs: string[] = []
const WORKSPACE = join(tmpdir(), 'dsh-agent-base-service-runtime-workspace')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeState(clock: FakeClock): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-base-svc-runtime-'))
  tempDirs.push(dir)
  return createStateStore({ path: join(dir, 'scheduler.json'), clock })
}

function textTask(id = 'demo', overrides: Partial<TextTaskDef> = {}): TextTaskDef {
  return {
    id,
    name: `任务 ${id}`,
    cron: '* * * * *',
    enabled: true,
    kind: 'text',
    text: `ping ${id}`,
    ...overrides,
  }
}

interface ServiceHarness {
  readonly service: SchedulerService
  readonly clock: FakeClock
  readonly timer: FakeTimer
  readonly counting: CountingTimer
  readonly state: StateStore
  readonly delivery: DeliveryHarness
  readonly exec: ExecHarness
  readonly logger: CapturedLogger
  readonly store: Pick<TaskStore, 'list' | 'get'>
}

interface ServiceOptions {
  readonly tasks?: readonly TaskDef[]
  readonly store?: Pick<TaskStore, 'list' | 'get'>
  readonly clock?: FakeClock
  readonly delivery?: DeliveryHarness
}

async function makeService(options: ServiceOptions = {}): Promise<ServiceHarness> {
  const clock = options.clock ?? new FakeClock('2026-01-01T00:00:00.000Z')
  const timer = new FakeTimer(clock)
  const counting = new CountingTimer(timer)
  const state = await makeState(clock)
  const delivery = options.delivery ?? createDelivery()
  const exec = createExec({ stdout: '{"shouldWake":false}\n' })
  const logger = captureLogger()
  const store = options.store ?? createStore(options.tasks ?? [textTask()])
  const service = new SchedulerService({
    store,
    delivery: delivery.port,
    state,
    exec: exec.exec,
    clock,
    timer: counting,
    logger: logger.logger,
    timezone: 'UTC',
    workspace: WORKSPACE,
    validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
  })
  return { service, clock, timer, counting, state, delivery, exec, logger, store }
}

function outcomeOf(outcome: TaskRunOutcome | undefined): TaskRunOutcome {
  if (outcome === undefined) throw new Error('期望有结局，实际 undefined')
  return outcome
}

/** 可逐次释放的投递（每次调用返回一个挂起 promise）。 */
function deferredDelivery(): {
  readonly delivery: DeliveryHarness
  readonly releases: Array<(result: DeliveryResult) => void>
} {
  const releases: Array<(result: DeliveryResult) => void> = []
  const delivery = createDelivery({
    deliver: () =>
      new Promise<DeliveryResult>((resolve) => {
        releases.push((result) => resolve(result))
      }),
  })
  return { delivery, releases }
}

describe('SchedulerService · timer 不变量补测', () => {
  it('多任务连续多轮：任意时刻活跃 timer 数不超过任务数，无叠加、无泄漏', async () => {
    const harness = await makeService({
      tasks: [textTask('aaa'), textTask('bbb'), textTask('ccc')],
    })
    harness.service.start()

    expect(harness.timer.pending).toBe(3)
    expect(harness.counting.maxActive).toBe(3)

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await harness.timer.advance(60_000)
      expect(harness.delivery.deliver).toHaveBeenCalledTimes(cycle * 3)
      expect(harness.timer.pending).toBe(3)
      expect(harness.counting.pending).toBe(3)
      expect(harness.service.scheduledIds).toEqual(['aaa', 'bbb', 'ccc'])
    }

    // 触发过程中 `arm` 会 clear + set，但任何时刻都不允许出现第 4 条 timer。
    expect(harness.counting.maxActive).toBe(3)
    // 每轮至少发生一次「立即重装 + 结算后重装」，证明链式重排真实发生。
    expect(harness.counting.setCalls).toBeGreaterThanOrEqual(3 + 3 * 2)
  })

  it('超长延时被截断：提前醒来只重装不执行，到点后恰好执行一次', async () => {
    // 2026-01-02 起，下一次 `0 0 1 1 *` 是 2027-01-01：约 364 天，远超 2^31-1ms。
    const clock = new FakeClock('2026-01-02T00:00:00.000Z')
    const harness = await makeService({
      tasks: [textTask('yearly', { cron: '0 0 1 1 *' })],
      clock,
    })
    harness.service.start()

    expect(harness.timer.pending).toBe(1)
    expect(harness.counting.setCalls).toBe(1)

    // 第一次被截断后醒来：目标时刻还没到，只能重装。
    await harness.timer.advance(MAX_TIMER_DELAY_MS)
    expect(harness.delivery.deliver).not.toHaveBeenCalled()
    expect(harness.service.lastOutcome('yearly')).toBeUndefined()
    expect(harness.timer.pending).toBe(1)
    expect(harness.counting.setCalls).toBe(2)

    // 继续推进到真实目标时刻：只执行一次，且下一次 timer 已重新装上。
    const target = Date.parse('2027-01-01T00:00:00.000Z')
    await harness.timer.advance(target - clock.now().getTime())
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.timer.pending).toBe(1)
    expect(harness.service.scheduledIds).toEqual(['yearly'])
    expect(harness.service.lastOutcome('yearly')?.kind).toBe('woke')
  })

  it('单任务链式重排：每次到点只执行一次，且下一次 timer 始终存在', async () => {
    const harness = await makeService({ tasks: [textTask()] })
    harness.service.start()

    for (let cycle = 1; cycle <= 5; cycle += 1) {
      await harness.timer.advance(60_000)
      expect(harness.delivery.deliver).toHaveBeenCalledTimes(cycle)
      expect(harness.timer.pending).toBe(1)
      expect(harness.counting.maxActive).toBe(1)
    }
  })
})

describe('SchedulerService · 重载与代际守卫补测', () => {
  it('reload() 保留单飞锁：在飞任务不会被叠出第二条执行链', async () => {
    const { delivery, releases } = deferredDelivery()
    const harness = await makeService({ tasks: [textTask()], delivery })
    harness.service.start()

    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.service.isRunning('demo')).toBe(true)

    harness.service.reload()
    expect(harness.timer.pending).toBe(1)
    expect(harness.service.scheduledIds).toEqual(['demo'])

    // 重载后的下一次到点：锁仍被旧运行占用 → skipped，不重复投递。
    await harness.timer.advance(60_000)
    const skipped = outcomeOf(harness.service.lastOutcome('demo'))
    expect(skipped.kind).toBe('skipped')
    if (skipped.kind !== 'skipped') return
    expect(skipped.reason).toContain('already running')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.service.isRunning('demo')).toBe(true)
    expect(harness.timer.pending).toBe(1)

    releases[0]?.('delivered')
    await flush()
    expect(harness.service.isRunning('demo')).toBe(false)
    expect(harness.timer.pending).toBe(1)

    // 旧运行结算后，下一条执行链正常继续。
    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)
    expect(harness.timer.pending).toBe(1)
  })

  it('reload() 多任务：数量正确、无双份 timer、每任务各触发一次', async () => {
    const harness = await makeService({
      tasks: [textTask('aaa'), textTask('bbb'), textTask('ccc')],
    })
    harness.service.start()
    harness.service.reload()

    expect(harness.timer.pending).toBe(3)
    expect(harness.counting.pending).toBe(3)
    expect(harness.service.scheduledIds).toEqual(['aaa', 'bbb', 'ccc'])
    expect(harness.counting.maxActive).toBe(3)

    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(3)
    expect(harness.timer.pending).toBe(3)
    expect(harness.counting.maxActive).toBe(3)
  })

  it('reload() 移除任务后，旧 fire 结算不得复活 timer', async () => {
    const tasks: TaskDef[] = [textTask()]
    const store = {
      list: () => ({ tasks: [...tasks], corrupted: [] }),
      get: (id: string): TaskDef | undefined => tasks.find((task) => task.id === id),
    }
    const { delivery, releases } = deferredDelivery()
    const harness = await makeService({ store, delivery })
    harness.service.start()

    await harness.timer.advance(60_000)
    expect(harness.service.isRunning('demo')).toBe(true)

    // 重载时任务已被删除：clearAll 自增 epoch，且不再装配。
    tasks.splice(0, tasks.length)
    harness.service.reload()
    expect(harness.service.scheduledIds).toEqual([])
    expect(harness.timer.pending).toBe(0)
    const callsAfterReload = harness.counting.setCalls

    // 旧运行结算：代际守卫必须阻止 `finally` 里的 arm。
    releases[0]?.('delivered')
    await flush()
    expect(harness.counting.setCalls).toBe(callsAfterReload)
    expect(harness.service.scheduledIds).toEqual([])
    expect(harness.timer.pending).toBe(0)

    await harness.timer.advance(10 * 60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
  })

  it('stop() 后旧 fire 结算不重装 timer；随后 start() 的新链不受影响', async () => {
    const { delivery, releases } = deferredDelivery()
    const harness = await makeService({ tasks: [textTask()], delivery })
    harness.service.start()

    await harness.timer.advance(60_000)
    expect(harness.service.isRunning('demo')).toBe(true)

    harness.service.stop()
    expect(harness.service.isRunning('demo')).toBe(false)
    expect(harness.timer.pending).toBe(0)

    harness.service.start()
    const callsAfterStart = harness.counting.setCalls
    expect(harness.timer.pending).toBe(1)

    // 旧 fire 结算：代际已变，不得再 setTimer。
    releases[0]?.('delivered')
    await flush()
    expect(harness.counting.setCalls).toBe(callsAfterStart)
    expect(harness.timer.pending).toBe(1)
    expect(harness.service.scheduledIds).toEqual(['demo'])

    // 新链照常触发一次。
    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)
    expect(harness.timer.pending).toBe(1)
  })

  it('stop() 后旧 fire 结算不重装 timer（不 restart）', async () => {
    const { delivery, releases } = deferredDelivery()
    const harness = await makeService({ tasks: [textTask()], delivery })
    harness.service.start()

    await harness.timer.advance(60_000)
    harness.service.stop()
    const callsAtStop = harness.counting.setCalls
    expect(harness.timer.pending).toBe(0)

    releases[0]?.('delivered')
    await flush()
    expect(harness.counting.setCalls).toBe(callsAtStop)
    expect(harness.timer.pending).toBe(0)
    expect(harness.service.scheduledIds).toEqual([])

    await harness.timer.advance(10 * 60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
  })
})

describe('SchedulerService · 并发补测', () => {
  it('runNow 占用时，定时触发判为 skipped，不排队、不重复投递', async () => {
    const { delivery, releases } = deferredDelivery()
    const harness = await makeService({ tasks: [textTask()], delivery })
    harness.service.start()

    const manual = harness.service.runNow('demo')
    await flush()
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)

    // 定时器到点：与 runNow 共用锁 → skipped。
    await harness.timer.advance(60_000)
    const skipped = outcomeOf(harness.service.lastOutcome('demo'))
    expect(skipped.kind).toBe('skipped')
    if (skipped.kind !== 'skipped') return
    expect(skipped.reason).toContain('already running')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.timer.pending).toBe(1)

    releases[0]?.('delivered')
    expect((await manual).kind).toBe('woke')
    await flush()
    expect(harness.service.isRunning('demo')).toBe(false)

    // 链没有被 skipped 打断，下一次照常执行。
    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)
  })
})

describe('SchedulerService · 已知风险探针', () => {
  it.fails('stop→start 后，旧在飞任务完成不得覆盖更新的 lastOutcome', async () => {
    const { delivery, releases } = deferredDelivery()
    const task = textTask()
    const harness = await makeService({ tasks: [task], delivery })
    harness.service.start()

    // 第一次触发（V1）挂起。
    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)

    harness.service.stop()
    harness.service.start()

    // 第二次触发（V2）完成得更早。
    ;(task as { text: string }).text = 'V2'
    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)
    releases[1]?.('delivered')
    await flush()
    expect(harness.service.lastOutcome('demo')?.kind).toBe('woke')
    if (harness.service.lastOutcome('demo')?.kind !== 'woke') return
    expect(
      (harness.service.lastOutcome('demo') as Extract<TaskRunOutcome, { kind: 'woke' }>).data,
    ).toBe('V2')

    // 旧运行（V1）这时才结算：当前实现会覆盖 lastOutcome。
    releases[0]?.('delivered')
    await flush()
    const last = harness.service.lastOutcome('demo')
    expect(last?.kind).toBe('woke')
    if (last?.kind !== 'woke') return
    expect(last.data).toBe('V2')
  })
})

describe('SchedulerService · 文本触发补测', () => {
  it('text 任务到点按触发时刻展开占位符并投递', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const harness = await makeService({
      tasks: [textTask('clock', { text: 'now={{time}} date={{date}} id={{task_id}}' })],
      clock,
    })
    harness.service.start()

    await harness.timer.advance(60_000)

    expect(harness.delivery.inputs).toHaveLength(1)
    expect(harness.delivery.inputs[0]?.text).toBe('now=00:01 date=2026-01-01 id=clock')
    expect(harness.service.lastOutcome('clock')?.kind).toBe('woke')
    expect(harness.timer.pending).toBe(1)
  })
})
