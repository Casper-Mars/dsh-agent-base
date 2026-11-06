/**
 * 调度子系统**进程内装配级集成测试**（任务-08，替代容器 smoke）。
 *
 * 目标：不打容器、不碰 sanding、不起真实子进程、不真实 sleep，仍然验证
 * 「装配 → timer → 触发 → 投递 / 失败通知 → 状态窗口 → 重建」整条链路。
 *
 * 分两层：
 *   1. **mount 层**（真实 Cordis Context / `apply` / `mountScheduler` /
 *      TaskStore / StateStore / DeliveryPort + fake agents + fake timers）：
 *      text 到点投 main、不存在 / live 自定义 session、脚本程序缺失的失败通知。
 *      `mountScheduler` 不暴露 exec 注入，因此脚本执行分支放到 service 层。
 *   2. **SchedulerService 层**（真实 TaskStore / StateStore / DeliveryPort +
 *      fake ExecStrategy / FakeClock / FakeTimer）：script shouldWake 分支、
 *      24h 失败通知窗口跨重建、timer 停止 / 重建后重新装表。
 *
 * 临时目录一律 mkdtemp，afterEach 清理；不写用户目录。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, SchedulerConfig } from '../src/config.js'
import { apply } from '../src/index.js'
import { createDeliveryPort } from '../src/scheduler/deliver.js'
import type { AgentBaseDeliveryPort } from '../src/scheduler/deliver.js'
import { SchedulerService } from '../src/scheduler/service.js'
import { createStateStore } from '../src/scheduler/state.js'
import { createTaskStore } from '../src/scheduler/store.js'
import type { TaskDef, TextTaskDef } from '../src/scheduler/types.js'
import { CountingTimer, FakeClock, FakeTimer } from './helpers/fakes.js'

const tempDirs: string[] = []
const contexts: Context[] = []

/**
 * 真实 `setImmediate` 快照：mount 层用 vitest fake timers 时 `setImmediate` 也会
 * 被替换，而 `fs/promises` 的 I/O 完成需要真实事件循环轮转。用它轮询等待异步
 * 落盘 / 校验结算，避免用 sleep 或依赖 fake timer 的刷新次数。
 */
const realSetImmediate = setImmediate

async function waitUntil(check: () => boolean, attempts = 500): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return
    await new Promise<void>((resolve) => realSetImmediate(resolve))
  }
  throw new Error('waitUntil: 条件在限定轮次内未满足')
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // 已 dispose 的上下文忽略。
    }
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-scheduler-integration-'))
  tempDirs.push(dir)
  return dir
}

async function writeTask(workspace: string, task: Record<string, unknown>): Promise<string> {
  const dir = path.join(workspace, '.agent-base', 'tasks')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${String(task.id)}.json`)
  await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  return file
}

/** 从 followup 收到的消息里取正文（notice 的 content 是 text block 数组）。 */
function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('')
}

// ---------------------------------------------------------------------------
// mount 层
// ---------------------------------------------------------------------------

interface MountHarness {
  readonly ctx: Context
  readonly main: ReturnType<typeof vi.fn>
  readonly custom: ReturnType<typeof vi.fn>
  readonly logs: string[]
  readonly stat: ReturnType<typeof vi.fn>
}

interface MountOptions {
  /** 自定义 session 是否 live（决定 agents.get 命中）。 */
  readonly customLive?: boolean
  /** `sessionPersistence.stat` 的返回：不存在 / 有快照 / 抛错。 */
  readonly stat?: 'missing' | 'exists' | 'error'
}

function createMountHarness(options: MountOptions = {}): MountHarness {
  const logs: string[] = []
  const main = vi.fn()
  const custom = vi.fn()
  const agents = new Map<string, { followup: typeof main }>([['main', { followup: main }]])
  if (options.customLive === true) agents.set('sess-custom', { followup: custom })

  const stat = vi.fn(async () => {
    if (options.stat === 'error') throw new Error('persistence unavailable')
    if (options.stat === 'exists') return { id: 'sess-custom' }
    return undefined
  })

  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('workspaceRegistry' as never, {
    create: async (workspacePath: string): Promise<Workspace> =>
      ({
        id: 'ws-1',
        path: workspacePath,
        title: path.basename(workspacePath),
        attachSession: vi.fn(),
      }) as unknown as Workspace,
  } as never)
  ctx.provide('sessionPersistence' as never, { stat } as never)
  ctx.provide('agents' as never, {
    get: (id: string) => agents.get(id),
  } as never)

  // mount 层通过 ctx.logger('agent-base:scheduler') 取出口；这里覆盖为收集器。
  const record =
    (level: string) =>
    (message: string): void => {
      logs.push(`${level}: ${message}`)
    }
  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: () => ({
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    }),
  })

  return { ctx, main, custom, logs, stat }
}

function mountConfig(workspace: string, scheduler: Partial<SchedulerConfig> = {}): Config {
  return {
    workspace,
    mainSessionId: 'main',
    validateExistingMain: false,
    scheduler: { timezone: 'UTC', ...scheduler } as SchedulerConfig,
  }
}

describe('装配级 · mountScheduler（真实 Context / fake agents / fake timers）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('text 任务到点投 main：正文占位符按触发时刻展开', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, {
      id: 'demo',
      name: '演示任务',
      cron: '*/1 * * * *',
      enabled: true,
      kind: 'text',
      text: 'hello {{task_id}} at {{time}}',
    })
    const h = createMountHarness()

    await apply(h.ctx, mountConfig(workspace))
    expect(h.ctx.agentScheduler.scheduledIds).toEqual(['demo'])

    await vi.advanceTimersByTimeAsync(60_000)
    await waitUntil(() => h.main.mock.calls.length === 1)

    expect(h.main).toHaveBeenCalledTimes(1)
    expect(textOf(h.main.mock.calls[0]?.[0])).toBe('hello demo at 00:01')
    expect(h.ctx.agentScheduler.lastOutcome('demo')?.kind).toBe('woke')
  })

  it('不存在的 session_id：error 日志「不存在 / 回退 main」，main 实收且任务文件不被改写', async () => {
    const workspace = await makeWorkspace()
    const file = await writeTask(workspace, {
      id: 'ghost-target',
      name: '幽灵目标',
      cron: '* * * * *',
      enabled: true,
      kind: 'text',
      text: 'fallback body',
      session_id: 'ghost',
    })
    const h = createMountHarness({ stat: 'missing' })

    await apply(h.ctx, mountConfig(workspace))
    await vi.advanceTimersByTimeAsync(60_000)
    await waitUntil(() => h.main.mock.calls.length === 1)

    expect(h.main).toHaveBeenCalledTimes(1)
    expect(h.custom).not.toHaveBeenCalled()
    expect(textOf(h.main.mock.calls[0]?.[0])).toBe('fallback body')

    const joined = h.logs.join('\n')
    expect(joined).toMatch(/ghost/)
    expect(joined).toMatch(/不存在|未 live/)
    expect(joined).toMatch(/回退 main/)

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(raw.session_id).toBe('ghost')
    expect(h.stat).toHaveBeenCalledWith('ghost')
  })

  it('存在且 live 的 session_id：自定义 session 收到，main 不收', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, {
      id: 'custom-target',
      name: '自定义目标',
      cron: '* * * * *',
      enabled: true,
      kind: 'text',
      text: 'ping custom',
      session_id: 'sess-custom',
    })
    const h = createMountHarness({ customLive: true, stat: 'exists' })

    await apply(h.ctx, mountConfig(workspace))
    await vi.advanceTimersByTimeAsync(60_000)
    await waitUntil(() => h.custom.mock.calls.length === 1)

    expect(h.custom).toHaveBeenCalledTimes(1)
    expect(h.main).not.toHaveBeenCalled()
    expect(h.ctx.agentScheduler.lastOutcome('custom-target')?.kind).toBe('woke')
  })

  it('script 程序缺失：failed/missing，24h 内连续两次失败只发 1 条通知', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, {
      id: 'broken-script',
      name: '缺失程序',
      cron: '* * * * *',
      enabled: true,
      task_path: 'programs/missing.mjs',
    })
    const h = createMountHarness()

    await apply(h.ctx, mountConfig(workspace))

    await vi.advanceTimersByTimeAsync(60_000)
    await waitUntil(() => h.ctx.agentScheduler.lastOutcome('broken-script') !== undefined)
    expect(h.main).toHaveBeenCalledTimes(1)
    const first = h.ctx.agentScheduler.lastOutcome('broken-script')
    expect(first?.kind).toBe('failed')
    if (first?.kind === 'failed') {
      expect(first.failureKind).toBe('missing')
      expect(first.notified).toBe(true)
    }

    await vi.advanceTimersByTimeAsync(60_000)
    await waitUntil(() => h.ctx.agentScheduler.status('broken-script')?.consecutiveFailures === 2)
    // 第二次失败在 24h 窗口内：不再投递通知（followup 仍为 1）。
    expect(h.main).toHaveBeenCalledTimes(1)
    const status = h.ctx.agentScheduler.status('broken-script')
    expect(status?.consecutiveFailures).toBe(2)
    expect(status?.lastFailureKind).toBe('missing')
    expect(status?.nextNotifyAt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// SchedulerService 层
// ---------------------------------------------------------------------------

interface ServiceHarness {
  readonly service: SchedulerService
  readonly clock: FakeClock
  readonly timer: FakeTimer
  readonly counting: CountingTimer
  readonly followup: ReturnType<typeof vi.fn>
  readonly delivery: AgentBaseDeliveryPort
  readonly store: ReturnType<typeof createTaskStore>
}

interface ServiceHarnessOptions {
  readonly workspace: string
  readonly tasks: readonly TaskDef[]
  readonly clock?: FakeClock
  readonly stdout?: string | (() => string)
}

async function makeServiceHarness(options: ServiceHarnessOptions): Promise<ServiceHarness> {
  const clock = options.clock ?? new FakeClock('2026-01-01T00:00:00.000Z')
  const timer = new FakeTimer(clock)
  const counting = new CountingTimer(timer)
  const tasksDir = path.join(options.workspace, '.agent-base', 'tasks')
  const store = createTaskStore({ tasksDir })
  for (const task of options.tasks) store.save(task)
  const state = createStateStore({ path: path.join(options.workspace, '.agent-base', 'state', 'scheduler.json'), clock })

  const followup = vi.fn()
  const agents = new Map([['main', { followup }]])
  const delivery = createDeliveryPort({
    agents: { get: (id) => agents.get(id) },
    mainSessionId: 'main',
    clock,
  })

  const stdout = options.stdout ?? '{"shouldWake":false}\n'
  const exec = {
    name: 'fake',
    async exec() {
      return {
        exitCode: 0,
        stdout: typeof stdout === 'function' ? stdout() : stdout,
        stderr: '',
        truncated: false,
        timedOut: false,
      }
    },
  }

  const service = new SchedulerService({
    store,
    delivery,
    state,
    exec,
    clock,
    timer: counting,
    timezone: 'UTC',
    workspace: options.workspace,
  })
  return { service, clock, timer, counting, followup, delivery, store }
}

async function writeProgram(workspace: string, relative: string): Promise<void> {
  const file = path.join(workspace, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '// fake program (never spawned in tests)\n', 'utf8')
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

function scriptTask(id = 'script', overrides: Record<string, unknown> = {}): TaskDef {
  return {
    id,
    name: `脚本 ${id}`,
    cron: '* * * * *',
    enabled: true,
    task_path: 'programs/job.mjs',
    ...overrides,
  } as TaskDef
}

describe('装配级 · SchedulerService（真实 store/state/delivery + fake exec/timer）', () => {
  it('script shouldWake=true：解析 stdout 末行并投递 main', async () => {
    const workspace = await makeWorkspace()
    await writeProgram(workspace, 'programs/job.mjs')
    const h = await makeServiceHarness({
      workspace,
      tasks: [scriptTask()],
      stdout: 'log line\n{"shouldWake":true,"data":"script done"}\n',
    })
    h.service.start()
    await h.timer.advance(60_000)
    await waitUntil(() => h.followup.mock.calls.length === 1)

    expect(h.followup).toHaveBeenCalledTimes(1)
    expect(textOf(h.followup.mock.calls[0]?.[0])).toContain('script done')
    const outcome = h.service.lastOutcome('script')
    expect(outcome?.kind).toBe('woke')
    if (outcome?.kind === 'woke') {
      expect(outcome.data).toBe('script done')
      expect(outcome.targets).toEqual(['main'])
    }
  })

  it('script shouldWake=false：quiet，不投递', async () => {
    const workspace = await makeWorkspace()
    await writeProgram(workspace, 'programs/job.mjs')
    const h = await makeServiceHarness({
      workspace,
      tasks: [scriptTask()],
      stdout: '{"shouldWake":false}\n',
    })
    h.service.start()
    await h.timer.advance(60_000)
    await waitUntil(() => h.service.lastOutcome('script') !== undefined)

    expect(h.followup).not.toHaveBeenCalled()
    expect(h.service.lastOutcome('script')?.kind).toBe('quiet')
  })

  it('失败通知窗口跨调度器重建：24h 内第二次失败不投递，24h 后可再投递', async () => {
    const workspace = await makeWorkspace()
    // 程序不存在 → validate 直接 failed/missing，不触发 exec / 子进程。
    const task = scriptTask('broken', { task_path: 'programs/missing.mjs' })
    const first = await makeServiceHarness({ workspace, tasks: [task] })
    first.service.start()

    await first.timer.advance(60_000) // 00:01 第一次失败
    await waitUntil(() => first.followup.mock.calls.length === 1)
    expect(first.followup).toHaveBeenCalledTimes(1)
    expect(first.service.lastOutcome('broken')?.kind).toBe('failed')

    // 重建 service（同一 workspace / state 文件 / 投递端口），24h 内再失败。
    first.service.stop()
    const second = new SchedulerService({
      store: first.store,
      delivery: first.delivery,
      state: createStateStore({
        path: path.join(workspace, '.agent-base', 'state', 'scheduler.json'),
        clock: first.clock,
      }),
      exec: { name: 'fake', exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }) },
      clock: first.clock,
      timer: first.timer,
      timezone: 'UTC',
      workspace,
    })
    second.start()
    await first.timer.advance(60_000) // 00:02 第二次失败
    await waitUntil(() => second.status('broken').consecutiveFailures === 2)
    expect(first.followup).toHaveBeenCalledTimes(1) // 窗口内不投递
    expect(second.status('broken').consecutiveFailures).toBe(2)

    // 重建后的 service 停掉，再起一个；把时钟推到首次通知后恰好 24h。
    second.stop()
    const third = new SchedulerService({
      store: first.store,
      delivery: first.delivery,
      state: createStateStore({
        path: path.join(workspace, '.agent-base', 'state', 'scheduler.json'),
        clock: first.clock,
      }),
      exec: { name: 'fake', exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }) },
      clock: first.clock,
      timer: first.timer,
      timezone: 'UTC',
      workspace,
    })
    third.start()
    first.clock.set(Date.parse('2026-01-02T00:01:00.000Z'))
    await first.timer.advance(0) // 让已到期的 timer 立即触发
    await waitUntil(() => first.followup.mock.calls.length === 2)

    expect(first.followup).toHaveBeenCalledTimes(2) // 24h 闭区间：可再通知
    expect(third.status('broken').consecutiveFailures).toBe(3)
  })

  it('stop → start 重建 timer：重新装表、可再次触发，且同任务不双份 timer', async () => {
    const workspace = await makeWorkspace()
    const h = await makeServiceHarness({ workspace, tasks: [textTask('demo')] })

    h.service.start()
    expect(h.service.scheduledIds).toEqual(['demo'])
    expect(h.counting.pending).toBe(1)

    h.service.stop()
    expect(h.counting.pending).toBe(0)
    expect(h.service.scheduledIds).toEqual([])

    h.service.start()
    expect(h.service.scheduledIds).toEqual(['demo'])
    expect(h.counting.pending).toBe(1)
    expect(h.counting.maxActive).toBe(1)

    await h.timer.advance(60_000)
    await waitUntil(() => h.followup.mock.calls.length === 1)
    expect(h.followup).toHaveBeenCalledTimes(1)
    // 触发后链式重排：仍然只有一条 timer，没有叠加。
    expect(h.counting.pending).toBe(1)
    expect(h.counting.maxActive).toBe(1)

    expect(h.service.lastOutcome('demo')?.kind).toBe('woke')
  })
})
