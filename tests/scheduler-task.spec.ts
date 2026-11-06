/**
 * `runTask` 触发链测试（技术方案 §5.3）。
 *
 * 覆盖：kind 分支、文本占位符 / 截断 / 空文本、shouldWake 矩阵、五类失败归类、
 * 24h 失败通知窗口、冷却、目标回退。
 *
 * 全部依赖注入：执行器是 fake（**不起子进程**）、投递是 mock、时钟是假时钟、
 * 状态落在临时目录（不写用户目录）。
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
/** 不存在的 workspace：触发期文件校验必然 ENOENT。 */
const MISSING_WORKSPACE = join(tmpdir(), 'dsh-agent-base-missing-workspace')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeState(clock: FakeClock): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-base-task-'))
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
  readonly maxDeliverChars?: number
  readonly timezone?: string
  readonly workspace?: string
  readonly cooldown?: CooldownStore
  readonly tasksDir?: string
  readonly validate?: RunTaskDeps['validate']
}

/** 构造只认识单个任务（或「全部不存在」）的依赖集合。 */
async function makeHarness(
  task: TaskDef | undefined,
  options: HarnessOptions = {},
): Promise<Harness> {
  const clock = options.clock ?? new FakeClock()
  const state = options.state ?? (await makeState(clock))
  const delivery = options.delivery ?? createDelivery()
  const exec = options.exec ?? createExec()
  const logger = captureLogger()
  const cooldown = options.cooldown ?? createCooldownStore()

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
    timezone: options.timezone ?? 'UTC',
    workspace: options.workspace ?? MISSING_WORKSPACE,
    cooldown,
    ...(options.allowScript === undefined ? {} : { allowScript: options.allowScript }),
    ...(options.maxDeliverChars === undefined
      ? {}
      : { maxDeliverChars: options.maxDeliverChars }),
    ...(options.tasksDir === undefined ? {} : { tasksDir: options.tasksDir }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
  }

  return { deps, clock, state, delivery, exec, logger, cooldown }
}

/** 断言 `failed` 结局并返回它（避免测试里到处重复 narrow）。 */
function failedOf(outcome: TaskRunOutcome): Extract<TaskRunOutcome, { kind: 'failed' }> {
  if (outcome.kind !== 'failed') {
    throw new Error(`期望 failed，实际 ${outcome.kind}：${JSON.stringify(outcome)}`)
  }
  return outcome
}

describe('runTask · 文本任务', () => {
  it('展开占位符后投递（woke），并记录成功', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const task = textTask({ text: '日期 {{date}} 时间 {{time}} 任务 {{task_id}} 时区 {{timezone}}' })
    const harness = await makeHarness(task, { clock, timezone: 'UTC' })

    const outcome = await runTask('demo', harness.deps)

    expect(outcome.kind).toBe('woke')
    if (outcome.kind !== 'woke') return
    expect(outcome.data).toBe('日期 2026-01-01 时间 00:00 任务 demo 时区 UTC')
    expect(outcome.targets).toEqual(['main'])
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)

    const input = harness.delivery.inputs[0]
    expect(input?.summary).toBe('日期 2026-01-01 时间 00:00 任务 demo 时区 UTC')
    expect(harness.state.status('demo').lastSuccessAt).toBeDefined()
    expect(harness.state.status('demo').consecutiveFailures).toBe(0)
  })

  it('正文超过 maxDeliverChars 时按字素截断', async () => {
    const task = textTask({ text: 'abcdefghij' })
    const harness = await makeHarness(task, { maxDeliverChars: 5 })

    const outcome = await runTask('demo', harness.deps)

    expect(outcome.kind).toBe('woke')
    if (outcome.kind !== 'woke') return
    expect(outcome.data).toBe('abcde')
  })

  it('空正文 → quiet，不投递，但算一次成功', async () => {
    const harness = await makeHarness(textTask({ text: '   ' }))

    const outcome = await runTask('demo', harness.deps)

    expect(outcome.kind).toBe('quiet')
    expect(harness.delivery.deliver).not.toHaveBeenCalled()
    expect(harness.delivery.deliverNotice).not.toHaveBeenCalled()
    expect(harness.state.status('demo').lastSuccessAt).toBeDefined()
  })

  it('自定义 session 不可达时沿用解析后的回退目标', async () => {
    const task = textTask({ session_id: 'custom' })
    const delivery = createDelivery({
      target: { sessionId: 'main', fallbackFrom: 'custom', reason: 'session 不存在' },
    })
    const harness = await makeHarness(task, { delivery })

    const outcome = await runTask('demo', harness.deps)

    expect(outcome.kind).toBe('woke')
    if (outcome.kind !== 'woke') return
    expect(outcome.targets).toEqual(['main'])
    expect(outcome.fallbackFrom).toBe('custom')
    expect(harness.delivery.inputs[0]?.fallbackFrom).toBe('custom')
  })

  it('cooling: 投递成功后窗口内再次触发 → skipped，不回退执行', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const harness = await makeHarness(textTask({ cooldown_ms: 60_000 }), { clock })

    expect((await runTask('demo', harness.deps)).kind).toBe('woke')
    clock.advance(30_000)

    const second = await runTask('demo', harness.deps)
    expect(second.kind).toBe('skipped')
    if (second.kind !== 'skipped') return
    expect(second.reason).toContain('冷却')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1)

    clock.advance(40_000)
    expect((await runTask('demo', harness.deps)).kind).toBe('woke')
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(2)
  })
})

describe('runTask · 脚本任务', () => {
  it('shouldWake:false → quiet，不投递', async () => {
    const harness = await makeHarness(scriptTask(), {
      exec: createExec({ stdout: '{"shouldWake":false}\n' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = await runTask('demo', harness.deps)

    expect(outcome.kind).toBe('quiet')
    expect(harness.delivery.deliver).not.toHaveBeenCalled()
    expect(harness.state.status('demo').lastSuccessAt).toBeDefined()
  })

  it('shouldWake:true → 投递 data（woke）', async () => {
    const harness = await makeHarness(scriptTask(), {
      exec: createExec({ stdout: 'noise\n{"shouldWake":true,"data":"今日报告"}\n' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = await runTask('demo', harness.deps)

    expect(outcome.kind).toBe('woke')
    if (outcome.kind !== 'woke') return
    expect(outcome.data).toBe('今日报告')
    expect(harness.exec.calls[0]?.scriptPath).toBe('/abs/task.mjs')
    expect(harness.exec.calls[0]?.cwd).toBe('/abs')
  })

  it('allowScript=false → failed/runtime，且不执行子进程', async () => {
    const harness = await makeHarness(scriptTask(), {
      allowScript: false,
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('runtime')
    expect(outcome.notified).toBe(true)
    expect(outcome.consecutiveFailures).toBe(1)
    expect(harness.exec.calls).toHaveLength(0)
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)
    expect(harness.delivery.inputs[0]?.text).toContain('【定时任务失败】')
  })

  it('任务程序缺失 → failed/missing', async () => {
    const harness = await makeHarness(scriptTask({ task_path: 'not-exists.mjs' }), {
      workspace: MISSING_WORKSPACE,
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('missing')
    expect(outcome.detail).toContain('任务程序不存在')
    expect(harness.exec.calls).toHaveLength(0)
  })

  it('扩展名不受支持 → failed/runtime', async () => {
    const harness = await makeHarness(scriptTask({ task_path: 'job.py' }), {
      workspace: MISSING_WORKSPACE,
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('runtime')
    expect(outcome.detail).toContain('扩展名不受支持')
  })

  it('spawn 失败 → failed/runtime', async () => {
    const harness = await makeHarness(scriptTask(), {
      exec: createExec({ spawnError: 'ENOENT' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('runtime')
    expect(outcome.detail).toBe('ENOENT')
  })

  it('非零退出 → failed/exec，detail 携带 stderr', async () => {
    const harness = await makeHarness(scriptTask(), {
      exec: createExec({ exitCode: 1, stderr: 'boom\n' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('exec')
    expect(outcome.detail).toBe('boom')
    expect(outcome.reason).toContain('exitCode=1')
  })

  it('超时 → failed/exec', async () => {
    const harness = await makeHarness(scriptTask(), {
      exec: createExec({ exitCode: null, timedOut: true }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('exec')
    expect(outcome.reason).toContain('超时')
  })

  it('stdout 超限 → failed/exec', async () => {
    const harness = await makeHarness(scriptTask(), {
      exec: createExec({ truncated: true }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('exec')
    expect(outcome.reason).toContain('stdout 超过上限')
  })

  it('末行不是合法 JSON → failed/parse', async () => {
    const harness = await makeHarness(scriptTask(), {
      exec: createExec({ stdout: 'not-json\n' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('parse')
  })

  it('投递抛错 → failed/deliver', async () => {
    const delivery = createDelivery({
      deliver: async () => {
        throw new Error('投递通道炸了')
      },
    })
    const harness = await makeHarness(scriptTask(), {
      delivery,
      exec: createExec({ stdout: '{"shouldWake":true,"data":"x"}\n' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('deliver')
    expect(outcome.detail).toBe('投递通道炸了')
    expect(outcome.notified).toBe(true)
  })

  it('投递返回 skipped → skipped 结局（不计失败）', async () => {
    const harness = await makeHarness(scriptTask(), {
      delivery: createDelivery({ deliver: async () => 'skipped' }),
      exec: createExec({ stdout: '{"shouldWake":true,"data":"x"}\n' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = await runTask('demo', harness.deps)

    expect(outcome.kind).toBe('skipped')
    expect(harness.state.status('demo').consecutiveFailures).toBe(0)
  })

  it('投递返回 failed（main 从未 provisioned）→ failed/deliver', async () => {
    const harness = await makeHarness(scriptTask(), {
      delivery: createDelivery({ deliver: async () => 'failed' }),
      exec: createExec({ stdout: '{"shouldWake":true,"data":"x"}\n' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcome = failedOf(await runTask('demo', harness.deps))

    expect(outcome.failureKind).toBe('deliver')
    expect(outcome.reason).toBe('任务 demo 投递失败')
    expect(outcome.detail).toBe('main session 未 provisioned')
    expect(harness.state.status('demo').consecutiveFailures).toBe(1)
  })
})

describe('runTask · 失败通知与窗口', () => {
  it('连续失败 3 次只投递 1 条通知、日志 3 条；24h 后再失败才再通知', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const state = await makeState(clock)
    const harness = await makeHarness(scriptTask(), {
      clock,
      state,
      exec: createExec({ exitCode: 1, stderr: 'boom' }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const outcomes: TaskRunOutcome[] = []
    for (let index = 0; index < 3; index += 1) {
      outcomes.push(await runTask('demo', harness.deps))
      clock.advance(60_000)
    }

    expect(outcomes.map((outcome) => failedOf(outcome).notified)).toEqual([true, false, false])
    expect(outcomes.map((outcome) => failedOf(outcome).consecutiveFailures)).toEqual([1, 2, 3])
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)
    // 失败 N 次 = N 条失败日志（一次失败绝不刷多行）。
    expect(harness.logger.lines.filter((line) => line.includes('失败'))).toHaveLength(3)

    const notice = harness.delivery.inputs[0]?.text ?? ''
    expect(notice).toContain('连续失败：1 次')

    // 距首次通知满 24h：窗口重新打开。
    clock.advance(24 * 60 * 60 * 1000)
    const fourth = failedOf(await runTask('demo', harness.deps))
    expect(fourth.notified).toBe(true)
    expect(fourth.consecutiveFailures).toBe(4)
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(2)
  })

  it('失败通知投递失败时不消耗窗口（下次仍会尝试）', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const state = await makeState(clock)
    let attempts = 0
    const delivery = createDelivery({
      deliverNotice: async () => {
        attempts += 1
        return attempts === 1 ? 'skipped' : 'delivered'
      },
    })
    const harness = await makeHarness(scriptTask(), {
      clock,
      state,
      delivery,
      exec: createExec({ exitCode: 2 }),
      validate: async (_workspace, taskPath) => ({ path: `/abs/${taskPath}` }),
    })

    const first = failedOf(await runTask('demo', harness.deps))
    expect(first.notified).toBe(false)

    clock.advance(60_000)
    const second = failedOf(await runTask('demo', harness.deps))
    expect(second.notified).toBe(true)
    expect(delivery.deliverNotice).toHaveBeenCalledTimes(2)
  })

  it('任务定义缺失 → failed/missing，并走失败通知', async () => {
    const harness = await makeHarness(undefined)

    const outcome = failedOf(await runTask('ghost', harness.deps))

    expect(outcome.failureKind).toBe('missing')
    expect(outcome.reason).toContain('任务定义缺失')
    expect(outcome.notified).toBe(true)
    expect(harness.delivery.deliverNotice).toHaveBeenCalledTimes(1)
    expect(harness.delivery.inputs[0]?.text).toContain('ghost')
  })

  it('state 读任务抛错（id 非法）时不记账也不抛', async () => {
    const harness = await makeHarness(textTask())
    const broken: RunTaskDeps = {
      ...harness.deps,
      store: {
        get() {
          throw new Error('id 非法')
        },
      },
    }

    const outcome = failedOf(await runTask('bad/id', broken))

    expect(outcome.failureKind).toBe('missing')
    expect(outcome.notified).toBe(false)
    expect(outcome.consecutiveFailures).toBe(0)
  })
})
