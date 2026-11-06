/**
 * 调度子系统装配（`mountScheduler` / `ctx.agentScheduler`）的集成测试。
 *
 * 使用真实 Cordis `Context` + 真实 `apply`，只替换外部服务（workspaceRegistry /
 * agents / sessionPersistence / tools）与时间（fake timers）。覆盖：
 *   - Config schema 的调度默认值（尤其 `allowCustomSession=false`）；
 *   - `enabled=false`：零工具注册、零 timer、零服务；
 *   - `tools` 缺失时仍从磁盘加载任务并启动调度；
 *   - 默认装配 8 个工具、诊断服务可查询；
 *   - `allowCustomSession=false` 时 task_create / task_update schema 无 `session_id`；
 *   - 已有任务上的 session_id 在装配层不被改写，运行期仍按原语义投递；
 *   - `ctx.fiber.dispose()` 后停止调度、清理 timer、反注册工具。
 *
 * 临时目录全部通过 mkdtemp 创建并在 afterEach 清理；不真实 sleep、不起子进程。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'
import type { Config as AgentBaseConfig, SchedulerConfig } from '../src/config.js'
import { DEFAULT_SCHEDULER_CONFIG } from '../src/config.js'
import { apply } from '../src/index.js'

const tempDirs: string[] = []
const contexts: Context[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // 已 dispose 的上下文忽略。
    }
  }
  vi.useRealTimers()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agent-base-mount-'))
  tempDirs.push(dir)
  return dir
}

interface ToolsHarness {
  readonly registrations: ToolDefinition[]
  readonly disposers: Array<ReturnType<typeof vi.fn>>
  readonly register: ReturnType<typeof vi.fn>
}

interface Harness {
  readonly ctx: Context
  readonly tools: ToolsHarness
  readonly followup: ReturnType<typeof vi.fn>
  readonly agentGet: ReturnType<typeof vi.fn>
}

/** 真实 Context + 三个 inject 服务 + 可选 tools 替身。 */
function createHarness(options: { tools?: boolean } = {}): Harness {
  const registrations: ToolDefinition[] = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const register = vi.fn((definition: ToolDefinition) => {
    registrations.push(definition)
    const dispose = vi.fn()
    disposers.push(dispose)
    return dispose
  })

  const followup = vi.fn()
  const agentGet = vi.fn((id: string) => {
    if (id === 'custom') return { followup }
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
  ctx.provide('sessionPersistence' as never, {
    stat: vi.fn(async () => undefined),
  } as never)
  ctx.provide('agents' as never, {
    get: agentGet as never,
  } as never)
  if (options.tools !== false) {
    ctx.provide('tools' as never, { register } as never)
  }

  return { ctx, tools: { registrations, disposers, register }, followup, agentGet }
}

/** 覆盖真实 Context 上的 logger 服务访问器；返回恢复函数。 */
function overrideLogger(ctx: Context, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(ctx, 'logger')
  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  })
  return () => {
    if (descriptor === undefined) {
      delete (ctx as unknown as { logger?: unknown }).logger
    } else {
      Object.defineProperty(ctx, 'logger', descriptor)
    }
  }
}

function configOf(workspace: string, scheduler?: Partial<SchedulerConfig>): AgentBaseConfig {
  return {
    workspace,
    mainSessionId: 'main',
    ...(scheduler === undefined ? {} : { scheduler: scheduler as SchedulerConfig }),
  }
}

async function writeTask(workspace: string, task: Record<string, unknown>): Promise<string> {
  const dir = path.join(workspace, '.agent-base', 'tasks')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${String(task.id)}.json`)
  await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  return file
}

function textTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('Config.scheduler 默认值', () => {
  it('子对象缺省时补齐全部默认值，allowCustomSession 默认 false', () => {
    const parsed = Config({ workspace: '/tmp/ws', mainSessionId: 'main' }) as AgentBaseConfig

    expect(parsed.scheduler).toBeDefined()
    expect(parsed.scheduler?.enabled).toBe(true)
    expect(parsed.scheduler?.timezone).toBe(DEFAULT_SCHEDULER_CONFIG.timezone)
    expect(parsed.scheduler?.tasksDir).toBe('.agent-base/tasks')
    expect(parsed.scheduler?.allowScript).toBe(true)
    expect(parsed.scheduler?.allowCustomSession).toBe(false)
    expect(parsed.scheduler?.scriptTimeoutMs).toBe(60_000)
    expect(parsed.scheduler?.maxOutputBytes).toBe(1_048_576)
    expect(parsed.scheduler?.maxDeliverChars).toBe(4_000)
    expect(parsed.scheduler?.deliverOnOffline).toBe('queue')
    expect(parsed.scheduler?.pendingTtlMs).toBe(600_000)
    expect(parsed.scheduler?.maxPendingPerTask).toBe(20)
  })

  it('子对象被整体替换时，未写字段仍由 schema 补齐', () => {
    const parsed = Config({
      workspace: '/tmp/ws',
      mainSessionId: 'main',
      scheduler: { enabled: false },
    }) as AgentBaseConfig

    expect(parsed.scheduler?.enabled).toBe(false)
    expect(parsed.scheduler?.allowCustomSession).toBe(false)
    expect(parsed.scheduler?.tasksDir).toBe('.agent-base/tasks')
    expect(parsed.scheduler?.timezone).toBe(DEFAULT_SCHEDULER_CONFIG.timezone)
  })
})

describe('mountScheduler', () => {
  it('enabled=false 时不注册工具、不创建 timer、不发布服务，其余 apply 行为不变', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx, tools } = createHarness()

    await apply(ctx, configOf(workspace, { enabled: false }))

    expect(ctx.get('agentBase')).toBeDefined()
    expect(ctx.get('agentScheduler')).toBeUndefined()
    expect(tools.register).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tools 服务缺失时仍从磁盘加载任务并启动调度，不崩不抛', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx } = createHarness({ tools: false })

    await expect(apply(ctx, configOf(workspace))).resolves.toBeUndefined()

    const scheduler = ctx.get('agentScheduler')
    expect(scheduler).toBeDefined()
    expect(scheduler?.scheduledIds).toEqual(['demo'])
    expect(vi.getTimerCount()).toBe(1)
  })

  it('默认装配 8 个工具，诊断服务可查询 scheduledIds / status', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx, tools } = createHarness()

    await apply(ctx, configOf(workspace))

    expect(tools.registrations.map((definition) => definition.name).sort()).toEqual([
      'task_create',
      'task_delete',
      'task_disable',
      'task_enable',
      'task_get',
      'task_list',
      'task_run_now',
      'task_update',
    ])

    const scheduler = ctx.agentScheduler
    expect(scheduler.scheduledIds).toEqual(['demo'])
    expect(scheduler.isRunning('demo')).toBe(false)
    expect(scheduler.lastOutcome('demo')).toBeUndefined()
    expect(scheduler.status('demo')?.consecutiveFailures).toBe(0)
    expect(scheduler.status('missing')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('allowCustomSession 缺省 false：创建/更新工具 schema 不含 session_id', async () => {
    const workspace = await makeWorkspace()
    const { ctx, tools } = createHarness()

    await apply(ctx, configOf(workspace))

    for (const name of ['task_create', 'task_update']) {
      const definition = tools.registrations.find((tool) => tool.name === name)
      expect(definition).toBeDefined()
      const properties = (definition?.parameters as { properties: Record<string, unknown> })
        .properties
      expect(Object.keys(properties)).not.toContain('session_id')
    }
  })

  it('allowCustomSession=true 时 schema 才暴露 session_id', async () => {
    const workspace = await makeWorkspace()
    const { ctx, tools } = createHarness()

    await apply(ctx, configOf(workspace, { allowCustomSession: true }))

    const definition = tools.registrations.find((tool) => tool.name === 'task_create')
    const properties = (definition?.parameters as { properties: Record<string, unknown> })
      .properties
    expect(Object.keys(properties)).toContain('session_id')
  })

  it('已有任务上的 session_id 不被装配层改写，运行期仍按原语义投递', async () => {
    const workspace = await makeWorkspace()
    const file = await writeTask(
      workspace,
      textTask({ session_id: 'custom', text: 'ping custom' }),
    )
    const { ctx, followup } = createHarness()

    await apply(ctx, configOf(workspace))

    // 装配不重写任务文件。
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(raw.session_id).toBe('custom')

    const outcome = await ctx.agentScheduler.runNow('demo')
    expect(outcome.kind).toBe('woke')
    if (outcome.kind === 'woke') {
      expect(outcome.targets).toEqual(['custom'])
    }
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('tasksDir 为绝对路径时降级到默认目录，不影响启动', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx } = createHarness({ tools: false })

    await expect(
      apply(ctx, configOf(workspace, { tasksDir: path.join(workspace, 'elsewhere') })),
    ).resolves.toBeUndefined()

    expect(ctx.agentScheduler.scheduledIds).toEqual(['demo'])
  })

  it('单个工具注册失败时回滚已注册项，不抛且不阻断调度', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx, tools } = createHarness()

    let calls = 0
    tools.register.mockImplementation((definition: ToolDefinition) => {
      calls += 1
      if (calls === 2) throw new Error('duplicate tool name')
      tools.registrations.push(definition)
      const dispose = vi.fn()
      tools.disposers.push(dispose)
      return dispose
    })

    await expect(apply(ctx, configOf(workspace))).resolves.toBeUndefined()

    expect(tools.disposers).toHaveLength(1)
    expect(tools.disposers[0]).toHaveBeenCalledTimes(1)
    expect(ctx.agentScheduler.scheduledIds).toEqual(['demo'])
    expect(vi.getTimerCount()).toBe(1)
  })

  it('ctx.fiber.dispose() 后停止调度、清理 timer、反注册全部工具', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx, tools } = createHarness()

    await apply(ctx, configOf(workspace))
    const scheduler = ctx.agentScheduler
    expect(tools.disposers).toHaveLength(8)
    expect(vi.getTimerCount()).toBe(1)

    await ctx.fiber.dispose()

    expect(ctx.get('agentScheduler')).toBeUndefined()
    expect(scheduler.scheduledIds).toEqual([])
    for (const dispose of tools.disposers) expect(dispose).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ctx.logger 调用抛错时 apply 仍 resolve，工具注册与调度不受影响', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx, tools } = createHarness()
    const restore = overrideLogger(ctx, () => {
      throw new Error('logger service unavailable')
    })

    try {
      await expect(apply(ctx, configOf(workspace))).resolves.toBeUndefined()
    } finally {
      restore()
    }

    expect(ctx.get('agentBase')).toBeDefined()
    expect(tools.registrations).toHaveLength(8)
    expect(ctx.agentScheduler.scheduledIds).toEqual(['demo'])
    expect(vi.getTimerCount()).toBe(1)
  })

  it('ctx.logger 调用抛错且 enabled=false 时：apply resolve，logger 不被调用，零注册零 timer', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx, tools } = createHarness()
    let loggerCalls = 0
    const restore = overrideLogger(ctx, () => {
      loggerCalls += 1
      throw new Error('logger service unavailable')
    })

    try {
      await expect(
        apply(ctx, configOf(workspace, { enabled: false })),
      ).resolves.toBeUndefined()
    } finally {
      restore()
    }

    expect(ctx.get('agentBase')).toBeDefined()
    expect(ctx.get('agentScheduler')).toBeUndefined()
    expect(loggerCalls).toBe(0)
    expect(tools.register).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  const loggerShapes: Array<[string, unknown]> = [
    ['undefined（缺失）', undefined],
    ['非函数对象', { level: 'warn' }],
    ['返回无方法的对象', () => ({})],
  ]

  it.each(loggerShapes)(
    'ctx.logger 为 %s 时 apply 仍 resolve，工具注册与调度不受影响',
    async (_label, value) => {
      const workspace = await makeWorkspace()
      await writeTask(workspace, textTask())
      const { ctx, tools } = createHarness()
      const restore = overrideLogger(ctx, value)

      try {
        await expect(apply(ctx, configOf(workspace))).resolves.toBeUndefined()
      } finally {
        restore()
      }

      expect(ctx.get('agentBase')).toBeDefined()
      expect(tools.registrations).toHaveLength(8)
      expect(ctx.agentScheduler.scheduledIds).toEqual(['demo'])
      expect(vi.getTimerCount()).toBe(1)
    },
  )

  it('logger 方法自身抛错时被隔离，不阻断装配与调度', async () => {
    const workspace = await makeWorkspace()
    await writeTask(workspace, textTask())
    const { ctx } = createHarness({ tools: false })
    const throwingLogger = {
      info: () => {
        throw new Error('info boom')
      },
      warn: () => {
        throw new Error('warn boom')
      },
      error: () => {
        throw new Error('error boom')
      },
      debug: () => {
        throw new Error('debug boom')
      },
    }
    const restore = overrideLogger(ctx, () => throwingLogger)

    try {
      // 绝对路径 tasksDir 会触发一次 log.warn，用于验证守护包装确实生效。
      await expect(
        apply(ctx, configOf(workspace, { tasksDir: path.join(workspace, 'elsewhere') })),
      ).resolves.toBeUndefined()
    } finally {
      restore()
    }

    expect(ctx.get('agentBase')).toBeDefined()
    expect(ctx.agentScheduler.scheduledIds).toEqual(['demo'])
    expect(vi.getTimerCount()).toBe(1)
  })
})
