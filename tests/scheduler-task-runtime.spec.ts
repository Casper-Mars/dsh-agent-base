/**
 * `runTask` 运行时补测：验收标准 5 / 6 / 7 / 8 的缺口。
 *
 * 覆盖：
 *   - text 投递结果为 `queued` 时同样算成功（结局 queued + 消耗冷却）；
 *   - 失败通知 `deliverNotice` 返回 `queued` 视为已通知（否则会重复排队）；
 *   - 24h 通知窗口的**闭区间边界**（23:59:59.999 不通知 / 恰好 24h 通知）；
 *   - 冷却只在投递成功后生效：执行失败 / 投递 skipped 都不消耗冷却；
 *   - 五类失败（missing / runtime / exec / parse / deliver）都带
 *     `notified` 与 `consecutiveFailures`。
 *
 * 全程注入 fake exec / delivery / clock / state：不起子进程、不真实 sleep。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStateStore } from '../src/scheduler/state.js'
import type { StateStore } from '../src/scheduler/state.js'
import { createCooldownStore, runTask } from '../src/scheduler/task.js'
import type { CooldownStore, RunTaskDeps, TaskStatePort } from '../src/scheduler/task.js'
import type {
  DeliveryResult,
  ScriptTaskDef,
  TaskDef,
  TaskRunOutcome,
  TextTaskDef,
} from '../src/scheduler/types.js'
import {
  FakeClock,
  captureLogger,
  createDelivery,
  createExec,
  type CapturedLogger,
  type DeliveryHarness,
  type ExecHarness,
} from './helpers/fakes.js'

const tempDirs: string[] = []
/** 不存在的 workspace：真实校验必然 ENOENT。 */
const MISSING_WORKSPACE = join(tmpdir(), 'dsh-agent-base-runtime-missing-workspace')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeState(clock: FakeClock): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-base-task-runtime-'))
  tempDirs.push(dir)
  return createStateStore({ path: join(dir, 'scheduler.json'), clock })
}

function textTask(overrides: Partial<TextTaskDef> = {}): TextTaskDef {
  return {
    id: 'demo',
    name: '演示任务',
    cron: '* * * * *',
    enabled: true,
    kind: 'text',
    text: 'hello',
    ...overrides,
  }
}

function scriptTask(overrides: Partial<ScriptTaskDef> = {}): ScriptTaskDef {
  return {
    id: 'demo',
    name: '演示任务',
    cron: '* * * * *',
    enabled: true,
    task_path: 'task.mjs',
    ...overrides,
  }
}

interface Harness {
  readonly deps: RunTaskDeps
  readonly clock: FakeClock
  readonly state: TaskStatePort
  readonly delivery: DeliveryHarness
  readonly exec: ExecHarness
  readonly logger: CapturedLogger
  readonly cooldown: CooldownStore
}

interface HarnessOptions {
  readonly clock?: FakeClock
  readonly state?: TaskStatePort
  readonly delivery?: DeliveryHarness
  readonly exec?: ExecHarness
  readonly allowScript?: boolean
  readonly workspace?: string
  readonly validate?: RunTaskDeps['validate']
}

async function makeHarness(task: TaskDef | undefined, options: HarnessOptions = {}): Promise<Harness> {
  const clock = options.clock ?? new FakeClock()
  const state = options.state ?? (await makeState(clock))
  const delivery = options.delivery ?? createDelivery()
  const exec = options.exec ?? createExec()
  const logger = captureLogger()
  const cooldown = createCooldownStore()

  const deps: RunTaskDeps = {
    store: {
      get: (id: string): TaskDef | undefined =>
        task !== undefined && id === task.id ? task : undefined,
    },
    delivery: delivery.port,
    exec: exec.exec,
    state,
    clock,
    logger: logger.logger,
    timezone: 'UTC',
    workspace: options.workspace ?? MISSING_WORKSPACE,
    cooldown,
    ...(options.allowScript === undefined ? {} : { allowScript: options.allowScript }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
  }
  return { deps, clock, state, delivery, exec, logger, cooldown }
}

function failedOf(outcome: TaskRunOutcome): Extract<TaskRunOutcome, { kind: 'failed' }> {
  if (outcome.kind !== 'failed') {
    throw new Error(`期望 failed，实际 ${outcome.kind}：${JSON.stringify(outcome)}`)
  }
  return outcome
}

const okValidate = async (_workspace: string, taskPath: string): Promise<{ path: string }> => ({
  path: `/abs/${taskPath}`,
})

describe('runTask · queued 语义补测', () => {
  it('text 投递 queued：结局 queued、算成功、消耗冷却', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const delivery = createDelivery({ deliver: async () => 'queued' })
    const harness = await makeHarness(textTask({ cooldown_ms: 60_000 }), { clock, delivery })

    const first = await runTask('demo', harness.deps)
    expect(first.kind).toBe('queued')
    if (first.kind !== 'queued') return
    expect(first.targets).toEqual(['main'])
    expect(harness.state.status('demo').lastSuccessAt).toBeDefined()
    expect(harness.state.status('demo').consecutiveFailures).toBe(0)

    clock.advance(30_000)
    const second = await runTask('demo', harness.deps)
    expect(second.kind).toBe('skipped')
    if (second.kind !== 'skipped') return
    expect(second.reason).toContain('冷却')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)

    clock.advance(30_000)
    expect((await runTask('demo', harness.deps)).kind).toBe('queued')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)
  })

  it('失败通知 deliverNotice 返回 queued 视为已通知，24h 内不重复排队', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const delivery = createDelivery({ deliverNotice: async () => 'queued' })
    const harness = await makeHarness(scriptTask(), {
      clock,
      delivery,
      exec: createExec({ exitCode: 1, stderr: 'boom' }),
      validate: okValidate,
    })

    const first = failedOf(await runTask('demo', harness.deps))
    expect(first.notified).toBe(true)
    expect(first.consecutiveFailures).toBe(1)
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)

    clock.advance(60_000)
    const second = failedOf(await runTask('demo', harness.deps))
    expect(second.notified).toBe(false)
    expect(second.consecutiveFailures).toBe(2)
    // queued 若被当成「未通知」，这里会重复排队。
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)

    clock.advance(24 * 60 * 60 * 1000)
    const third = failedOf(await runTask('demo', harness.deps))
    expect(third.notified).toBe(true)
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(2)
  })
})

describe('runTask · 24h 窗口边界补测', () => {
  it('闭区间：距上次通知 24h-1ms 不投递，恰好 24h 投递', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const harness = await makeHarness(scriptTask(), {
      clock,
      exec: createExec({ exitCode: 1, stderr: 'boom' }),
      validate: okValidate,
    })

    expect(failedOf(await runTask('demo', harness.deps)).notified).toBe(true)

    clock.advance(24 * 60 * 60 * 1000 - 1)
    expect(failedOf(await runTask('demo', harness.deps)).notified).toBe(false)
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)

    clock.advance(1)
    expect(failedOf(await runTask('demo', harness.deps)).notified).toBe(true)
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(2)
  })
})

describe('runTask · 冷却只由成功投递消耗', () => {
  it('执行失败不消耗冷却：失败后窗口内仍会正常执行并投递', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    let failing = true
    const exec = createExec(() =>
      failing
        ? { exitCode: 1, stderr: 'boom' }
        : { exitCode: 0, stdout: '{"shouldWake":true,"data":"ok"}\n' },
    )
    const harness = await makeHarness(scriptTask({ cooldown_ms: 60_000 }), {
      clock,
      exec,
      validate: okValidate,
    })

    const failed = failedOf(await runTask('demo', harness.deps))
    expect(failed.notified).toBe(true)
    expect(harness.delivery.deliver).not.toHaveBeenCalled()

    // 失败后 10s（仍在 60s 冷却窗口内）：必须真执行，而不是被失败消耗冷却。
    failing = false
    clock.advance(10_000)
    const second = await runTask('demo', harness.deps)
    expect(second.kind).toBe('woke')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)

    // 成功后 10s：冷却生效 → skipped。
    clock.advance(10_000)
    const third = await runTask('demo', harness.deps)
    expect(third.kind).toBe('skipped')
    if (third.kind !== 'skipped') return
    expect(third.reason).toContain('冷却')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)
  })

  it('投递返回 skipped 不消耗冷却：下一次触发仍会重新投递', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    let result: DeliveryResult = 'skipped'
    const delivery = createDelivery({ deliver: async () => result })
    const harness = await makeHarness(textTask({ cooldown_ms: 60_000 }), { clock, delivery })

    const first = await runTask('demo', harness.deps)
    expect(first.kind).toBe('skipped')
    if (first.kind !== 'skipped') return
    // 这是「投递端口 skipped」，不是冷却跳过。
    expect(first.detail).toContain('投递端口返回 skipped')

    result = 'delivered'
    clock.advance(10_000)
    const second = await runTask('demo', harness.deps)
    expect(second.kind).toBe('woke')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)

    clock.advance(10_000)
    expect((await runTask('demo', harness.deps)).kind).toBe('skipped')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)
  })
})

describe('runTask · 五类失败矩阵', () => {
  it('missing / runtime / exec / parse / deliver 均正确归类且带通知字段', async () => {
    const cases: Array<{
      readonly name: string
      readonly task: TaskDef
      readonly options: HarnessOptions
      readonly execCalls: number
    }> = [
      {
        name: 'missing',
        task: scriptTask({ task_path: 'no-such.mjs' }),
        options: { workspace: MISSING_WORKSPACE },
        execCalls: 0,
      },
      {
        name: 'runtime',
        task: scriptTask({ task_path: 'job.py' }),
        options: { workspace: MISSING_WORKSPACE },
        execCalls: 0,
      },
      {
        name: 'exec',
        task: scriptTask(),
        options: { exec: createExec({ exitCode: 1, stderr: 'boom' }), validate: okValidate },
        execCalls: 1,
      },
      {
        name: 'parse',
        task: scriptTask(),
        options: { exec: createExec({ stdout: 'not-json\n' }), validate: okValidate },
        execCalls: 1,
      },
      {
        name: 'deliver',
        task: scriptTask(),
        options: {
          exec: createExec({ stdout: '{"shouldWake":true,"data":"x"}\n' }),
          delivery: createDelivery({
            deliver: async () => {
              throw new Error('投递通道炸了')
            },
          }),
          validate: okValidate,
        },
        execCalls: 1,
      },
    ]

    for (const testCase of cases) {
      const harness = await makeHarness(testCase.task, testCase.options)
      const failed = failedOf(await runTask('demo', harness.deps))

      expect(failed.failureKind, testCase.name).toBe(testCase.name)
      expect(failed.notified, testCase.name).toBe(true)
      expect(failed.consecutiveFailures, testCase.name).toBe(1)
      expect(harness.exec.calls, testCase.name).toHaveLength(testCase.execCalls)
      expect(
        harness.delivery.inputs.some((input) => input.text.includes('【定时任务失败】')),
        testCase.name,
      ).toBe(true)
    }
  })
})
