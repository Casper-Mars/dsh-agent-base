/**
 * `SchedulerService` 装配与生命周期测试（技术方案 §5.4 / §7 / §9）。
 *
 * 覆盖验收标准 1–9：
 *   - fake timer 到点触发、`finally` 后按 cron 链式重排（不叠加）；
 *   - `stop()` 后代际守卫阻止旧 fire 补 timer；
 *   - `reload()` 不产生双份 timer；
 *   - 长任务期间第二次到点 → `skipped`（already running），不排队；
 *   - 连续失败 3 次只发 1 条通知、日志 3 条，24h 窗口过期后再发；
 *   - 成功清失败链、写 `lastSuccessAt`、不投递；
 *   - cron 非法 / 文件损坏 / 单任务装配异常 / 清单读取失败只 warn；
 *   - `stop()` 清空 `inFlight` 与 timer 登记表。
 *
 * 全程注入 fake timer + 假时钟 + 假执行器：不真实 sleep、不起子进程。
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
  Timer,
  TimerHandle,
} from '../src/scheduler/types.js'
import {
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

const tempDirs: string[] = []
const WORKSPACE = join(tmpdir(), 'dsh-agent-base-service-workspace')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeState(clock: FakeClock): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-base-svc-'))
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

function scriptTask(id = 'demo', overrides: Partial<ScriptTaskDef> = {}): ScriptTaskDef {
  return {
    id,
    name: `任务 ${id}`,
    cron: '* * * * *',
    enabled: true,
    task_path: 'task.mjs',
    ...overrides,
  }
}

interface ServiceHarness {
  readonly service: SchedulerService
  readonly clock: FakeClock
  readonly timer: FakeTimer
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
  readonly timer?: Timer
  readonly delivery?: DeliveryHarness
  readonly exec?: ExecHarness
  readonly logger?: CapturedLogger
}

/** 构造服务；任务文件校验一律注入为「路径即存在」，避免真实文件系统依赖。 */
async function makeService(options: ServiceOptions = {}): Promise<ServiceHarness> {
  const clock = options.clock ?? new FakeClock('2026-01-01T00:00:00.000Z')
  const timer = options.timer ?? new FakeTimer(clock)
  const state = await makeState(clock)
  const delivery = options.delivery ?? createDelivery()
  const exec = options.exec ?? createExec({ stdout: '{"shouldWake":false}\n' })
  const logger = options.logger ?? captureLogger()
  const store = options.store ?? createStore(options.tasks ?? [textTask()])
  const service = new SchedulerService({
    store,
    delivery: delivery.port,
    state,
    exec: exec.exec,
    clock,
    timer,
    logger: logger.logger,
    timezone: 'UTC',
    workspace: WORKSPACE,
    validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
  })
  return { service, clock, timer: timer as FakeTimer, state, delivery, exec, logger, store }
}

function outcomeOf(outcome: TaskRunOutcome | undefined): TaskRunOutcome {
  if (outcome === undefined) throw new Error('期望有结局，实际 undefined')
  return outcome
}

describe('SchedulerService · timer 链', () => {
  it('到点触发，并按 cron 链式重排下一次（不叠加）', async () => {
    const harness = await makeService({ tasks: [textTask()] })
    harness.service.start()

    expect(harness.service.scheduledIds).toEqual(['demo'])
    expect(harness.timer.pending).toBe(1)

    await harness.timer.advance(59_000)
    expect(harness.delivery.deliver).not.toHaveBeenCalled()
    expect(harness.timer.pending).toBe(1)

    await harness.timer.advance(1_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.timer.pending).toBe(1)
    expect(harness.service.scheduledIds).toEqual(['demo'])

    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)
    expect(harness.timer.pending).toBe(1)
    expect(harness.timer.schedule).toHaveLength(1)
  })

  it('start 幂等：重复调用不产生第二份 timer', async () => {
    const harness = await makeService({ tasks: [textTask()] })
    harness.service.start()
    harness.service.start()

    expect(harness.timer.pending).toBe(1)

    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
  })

  it('stop() 后不再触发，且清空 timer 登记表', async () => {
    const harness = await makeService({ tasks: [textTask()] })
    harness.service.start()
    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)

    harness.service.stop()
    expect(harness.timer.pending).toBe(0)
    expect(harness.service.scheduledIds).toEqual([])

    await harness.timer.advance(10 * 60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
  })

  it('reload() 不产生双份 timer（旧句柄已清）', async () => {
    const harness = await makeService({ tasks: [textTask()] })
    harness.service.start()

    harness.service.reload()
    harness.service.reload()

    expect(harness.timer.pending).toBe(1)
    expect(harness.service.scheduledIds).toEqual(['demo'])

    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.timer.pending).toBe(1)
  })

  it('stop 后 start 可重新装配；未启动时 reload 无副作用', async () => {
    const harness = await makeService({ tasks: [textTask()] })

    harness.service.reload()
    expect(harness.service.scheduledIds).toEqual([])
    expect(harness.timer.pending).toBe(0)

    harness.service.start()
    expect(harness.timer.pending).toBe(1)

    harness.service.stop()
    expect(harness.timer.pending).toBe(0)

    harness.service.start()
    expect(harness.timer.pending).toBe(1)
    await harness.timer.advance(60_000)

    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.service.lastOutcome('demo')?.kind).toBe('woke')
  })

  it('长任务未结束时第二次到点 → skipped（already running），不排队', async () => {
    let release: () => void = () => {}
    const delivery = createDelivery({
      deliver: () =>
        new Promise<DeliveryResult>((resolve) => {
          release = () => resolve('delivered')
        }),
    })
    const harness = await makeService({ tasks: [textTask()], delivery })
    harness.service.start()

    await harness.timer.advance(60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.service.isRunning('demo')).toBe(true)

    // 第二次到点：单飞锁占用 → 直接 skipped，不排队、不重复投递。
    await harness.timer.advance(60_000)
    const skipped = outcomeOf(harness.service.lastOutcome('demo'))
    expect(skipped.kind).toBe('skipped')
    if (skipped.kind !== 'skipped') return
    expect(skipped.reason).toContain('already running')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
    expect(harness.timer.pending).toBe(1)

    release()
    await flush()
    expect(harness.service.isRunning('demo')).toBe(false)
    expect(harness.timer.pending).toBe(1)
  })

  it('runNow 与定时触发共用单飞锁', async () => {
    let release: () => void = () => {}
    const delivery = createDelivery({
      deliver: () =>
        new Promise<DeliveryResult>((resolve) => {
          release = () => resolve('delivered')
        }),
    })
    const harness = await makeService({ tasks: [textTask()], delivery })

    const first = harness.service.runNow('demo')
    const second = await harness.service.runNow('demo')
    expect(second.kind).toBe('skipped')
    if (second.kind !== 'skipped') return
    expect(second.reason).toContain('already running')

    release()
    expect((await first).kind).toBe('woke')
    expect(harness.service.isRunning('demo')).toBe(false)
  })
})

describe('SchedulerService · 失败链与日志', () => {
  it('连续失败 3 次：1 条失败通知、3 条失败日志；24h 窗口过期后再通知', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const harness = await makeService({
      tasks: [scriptTask()],
      clock,
      exec: createExec({ exitCode: 1, stderr: 'boom' }),
    })

    for (let index = 0; index < 3; index += 1) {
      const outcome = await harness.service.runNow('demo')
      expect(outcome.kind).toBe('failed')
      expect(harness.service.status('demo').consecutiveFailures).toBe(index + 1)
      clock.advance(60_000)
    }

    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)
    expect(harness.logger.lines.filter((line) => line.includes('失败'))).toHaveLength(3)

    const notifiedAt = harness.service.status('demo').nextNotifyAt
    expect(notifiedAt).toBeDefined()

    clock.advance(24 * 60 * 60 * 1000)
    await harness.service.runNow('demo')
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(2)
  })

  it('成功：清除失败链、写 lastSuccessAt、不投递任何消息', async () => {
    let failing = true
    const harness = await makeService({
      tasks: [scriptTask()],
      exec: createExec(() =>
        failing
          ? { exitCode: 1, stderr: 'boom' }
          : { exitCode: 0, stdout: '{"shouldWake":false}\n' },
      ),
    })

    await harness.service.runNow('demo')
    expect(harness.service.status('demo').consecutiveFailures).toBe(1)
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)
    expect(harness.delivery.deliver).not.toHaveBeenCalled()

    failing = false
    const outcome = await harness.service.runNow('demo')
    expect(outcome.kind).toBe('quiet')

    const status = harness.service.status('demo')
    expect(status.consecutiveFailures).toBe(0)
    expect(status.lastSuccessAt).toBeDefined()
    expect(status.firstFailureAt).toBeUndefined()
    // 恢复不产生消息。
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)
    expect(harness.delivery.deliver).not.toHaveBeenCalled()
  })
})

describe('SchedulerService · 异常隔离', () => {
  it('cron 非法 / 任务文件损坏 / 禁用任务：只 warn，不影响其它任务', async () => {
    const harness = await makeService({
      tasks: [
        textTask('bad', { cron: '61 * * * *' }),
        textTask('off', { enabled: false }),
        textTask('good'),
      ],
      store: createStore(
        [textTask('bad', { cron: '61 * * * *' }), textTask('off', { enabled: false }), textTask('good')],
        { corrupted: ['broken'] },
      ),
    })

    harness.service.start()

    expect(harness.service.scheduledIds).toEqual(['good'])
    expect(harness.timer.pending).toBe(1)
    const lines = harness.logger.lines.join('\n')
    expect(lines).toContain('损坏')
    expect(lines).toContain('cron 非法')
  })

  it('清单读取失败只 warn，不抛', async () => {
    const harness = await makeService({
      store: createStore([], { throwOnList: true }),
    })

    expect(() => harness.service.start()).not.toThrow()
    expect(harness.service.scheduledIds).toEqual([])
    expect(harness.timer.pending).toBe(0)
    expect(harness.logger.lines.join('\n')).toContain('读取任务清单失败')
  })

  it('单任务装配异常只 warn，其它任务照常调度', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const inner = new FakeTimer(clock)
    // 第一次 setTimer 抛错（模拟装配异常），之后正常。
    let calls = 0
    const throwingTimer: Timer = {
      setTimer(delayMs: number, cb: () => void): TimerHandle {
        calls += 1
        if (calls === 1) throw new Error('timer 炸了')
        return inner.setTimer(delayMs, cb)
      },
      clearTimer(handle: TimerHandle): void {
        inner.clearTimer(handle)
      },
    }
    const harness = await makeService({
      store: createStore([textTask('aaa'), textTask('bbb')]),
      clock,
      timer: throwingTimer,
    })

    expect(() => harness.service.start()).not.toThrow()
    expect(harness.service.scheduledIds).toEqual(['bbb'])
    expect(inner.pending).toBe(1)
    expect(harness.logger.lines.join('\n')).toContain('装配失败')
  })
})

describe('SchedulerService · stop 清理', () => {
  it('stop() 后 inFlight 与 timer 登记表清空，无悬挂定时器', async () => {
    let release: () => void = () => {}
    const delivery = createDelivery({
      deliver: () =>
        new Promise<DeliveryResult>((resolve) => {
          release = () => resolve('delivered')
        }),
    })
    const harness = await makeService({ tasks: [textTask()], delivery })
    harness.service.start()

    await harness.timer.advance(60_000)
    expect(harness.service.isRunning('demo')).toBe(true)

    harness.service.stop()
    expect(harness.service.isRunning('demo')).toBe(false)
    expect(harness.timer.pending).toBe(0)
    expect(harness.service.scheduledIds).toEqual([])
    expect(harness.service.running).toBe(false)

    // 旧 fire 结算后也不得再补 timer（代际守卫）。
    release()
    await flush()
    expect(harness.timer.pending).toBe(0)

    await harness.timer.advance(10 * 60_000)
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
  })

  it('目标解析抛错不穿透 fire（收敛为 failed/deliver）', async () => {
    const delivery = createDelivery()
    delivery.resolveTarget.mockRejectedValue(new Error('目标解析炸了'))
    const harness = await makeService({ tasks: [textTask()], delivery })
    harness.service.start()

    await harness.timer.advance(60_000)

    const outcome = outcomeOf(harness.service.lastOutcome('demo'))
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failureKind).toBe('deliver')
    // 定时链未被异常打断：下一次 timer 仍在。
    expect(harness.timer.pending).toBe(1)
  })
})
