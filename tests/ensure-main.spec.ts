/**
 * `ensureMain`（启动期后台准备 main session）的单元测试。
 *
 * 全部使用真实 Cordis `Context` + 注入的假服务；不创建真实 Agent、不访问磁盘
 * （cwd 比较用字符串相等路径，避开 realpath）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBaseService } from '../src/service.js'
import { ensureMain } from '../src/ensure-main.js'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // 已 dispose 的上下文忽略。
    }
  }
})

interface Logs {
  info: string[]
  warn: string[]
}

interface Harness {
  ctx: Context
  logs: Logs
  get: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  resolvePreset: ReturnType<typeof vi.fn>
  mount: ReturnType<typeof vi.fn>
  attachSession: ReturnType<typeof vi.fn>
  workspaceCreate: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

interface HarnessOptions {
  /** 初始 `agents.get` 返回值。 */
  live?: unknown
  /** `sessionPersistence.stat` 返回值 / 行为。 */
  stat?: unknown | (() => Promise<unknown>)
  /** 是否提供 agentPresets / agentDefaultModel。 */
  presets?: boolean
  defaultModel?: boolean
  /** 工作区 canonical 路径。 */
  cwd?: string
}

/** 构造真实 Context + 注入服务；logger 覆盖为可断言的记录器。 */
function createHarness(options: HarnessOptions = {}): Harness {
  const ctx = new Context()
  contexts.push(ctx)

  const logs: Logs = { info: [], warn: [] }
  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: () => ({
      info: (message: string) => logs.info.push(message),
      warn: (message: string) => logs.warn.push(message),
      error: () => {},
      debug: () => {},
    }),
  })

  const dispose = vi.fn()
  const agent = { id: 'main' }
  const live = options.live
  const get = vi.fn(() => live)
  const create = vi.fn(async () => ({ agent, dispose }))
  const resume = vi.fn(async () => ({ agent, dispose }))
  const stat =
    typeof options.stat === 'function'
      ? vi.fn(options.stat as () => Promise<unknown>)
      : vi.fn(async () => options.stat)
  const resolvePreset = vi.fn(async () => ({ id: 'default' }))
  const mount = vi.fn(async () => {})
  const attachSession = vi.fn(async () => {})
  const workspaceCreate = vi.fn(async () => ({ attachSession }))

  ctx.provide('agents' as never, { get, create, resume } as never)
  ctx.provide('sessionPersistence' as never, { stat } as never)
  ctx.provide('workspaceRegistry' as never, { create: workspaceCreate } as never)
  if (options.presets !== false) {
    ctx.provide('agentPresets' as never, { resolve: resolvePreset, mount } as never)
  }
  if (options.defaultModel !== false) {
    ctx.provide('agentDefaultModel' as never, {
      currentSelection: () => ({
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'low',
      }),
    } as never)
  }

  new AgentBaseService(ctx, {
    workspaceCwd: options.cwd ?? '/ws',
    mainSessionId: 'main' as never,
  })

  return {
    ctx,
    logs,
    get,
    create,
    resume,
    stat,
    resolvePreset,
    mount,
    attachSession,
    workspaceCreate,
    dispose,
  }
}

describe('ensureMain：状态机', () => {
  it('live 命中 → 直接复用，不 create / resume / stat', async () => {
    const h = createHarness({ live: { id: 'main' } })

    await ensureMain(h.ctx)

    expect(h.get).toHaveBeenCalledWith('main')
    expect(h.stat).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.logs.warn).toEqual([])
  })

  it('无快照 → create（带 agentOptions / setup / meta）+ attachSession，日志 created', async () => {
    const h = createHarness()

    await ensureMain(h.ctx)

    expect(h.stat).toHaveBeenCalledWith('main')
    expect(h.create).toHaveBeenCalledTimes(1)
    const args = h.create.mock.calls[0][0] as {
      sessionId: string
      meta: { cwd: string; agentPreset: string }
      agentOptions: unknown
      setup: (agentCtx: unknown) => Promise<void>
    }
    expect(args.sessionId).toBe('main')
    expect(args.meta).toEqual({ cwd: '/ws', agentPreset: 'default' })
    expect(args.agentOptions).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'low',
    })
    expect(typeof args.setup).toBe('function')
    await args.setup({})
    expect(h.mount).toHaveBeenCalledWith({}, 'default')

    expect(h.attachSession).toHaveBeenCalledWith('main')
    expect(h.logs.info).toContain('main session 已就绪（created）')
    expect(h.logs.warn).toEqual([])
  })

  it('有快照 → resume（带 agentOptions / setup），日志 resumed', async () => {
    const h = createHarness({ stat: { header: { cwd: '/ws' } } })

    await ensureMain(h.ctx)

    expect(h.create).not.toHaveBeenCalled()
    expect(h.resume).toHaveBeenCalledTimes(1)
    const args = h.resume.mock.calls[0][0] as {
      resumeSessionId: string
      agentOptions: { model: string }
      setup: (agentCtx: unknown) => Promise<void>
    }
    expect(args.resumeSessionId).toBe('main')
    expect(args.agentOptions.model).toBe('deepseek-chat')
    await args.setup({})
    expect(h.mount).toHaveBeenCalledWith({}, 'default')
    expect(h.logs.info).toContain('main session 已就绪（resumed）')
  })

  it('快照 cwd 与固定 workspace 不一致 → 拒绝 resume 并 warn', async () => {
    const h = createHarness({ stat: { header: { cwd: '/elsewhere' } } })

    await expect(ensureMain(h.ctx)).resolves.toBeUndefined()

    expect(h.resume).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
    expect(
      h.logs.warn.some((m) => m.includes('main session 准备失败') && m.includes('/ws')),
    ).toBe(true)
  })

  it('并发 5 次 → 只 create 1 次（single-flight）', async () => {
    const h = createHarness()

    await Promise.all([
      ensureMain(h.ctx),
      ensureMain(h.ctx),
      ensureMain(h.ctx),
      ensureMain(h.ctx),
      ensureMain(h.ctx),
    ])

    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.attachSession).toHaveBeenCalledTimes(1)
  })

  it('create 抛 already exists → 回读复用，不把异常抛给调用方', async () => {
    const h = createHarness()
    const existing = { id: 'main' }
    h.get.mockReturnValueOnce(undefined).mockReturnValue(existing)
    h.create.mockRejectedValueOnce(new Error('session "main" already exists'))

    await expect(ensureMain(h.ctx)).resolves.toBeUndefined()

    expect(h.get).toHaveBeenCalledTimes(2)
    expect(h.logs.warn).toEqual([])
    expect(h.dispose).not.toHaveBeenCalled()
  })

  it('准备超时 → 只 warn 并返回，不抛；底层继续在后台', async () => {
    const h = createHarness()
    h.create.mockImplementation(() => new Promise(() => {}))

    await expect(ensureMain(h.ctx, { timeoutMs: 10 })).resolves.toBeUndefined()

    expect(
      h.logs.warn.some((m) => m.includes('main session 准备超时（10ms），转入后台')),
    ).toBe(true)
  })

  it('缺 agentPresets → 可读错误经 warn 输出，且不 create', async () => {
    const h = createHarness({ presets: false })

    await ensureMain(h.ctx)

    expect(h.create).not.toHaveBeenCalled()
    expect(
      h.logs.warn.some((m) => m.includes('缺少 agentPresets 服务')),
    ).toBe(true)
  })

  it('缺 agentDefaultModel → 可读错误经 warn 输出，且不 create', async () => {
    const h = createHarness({ defaultModel: false })

    await ensureMain(h.ctx)

    expect(h.create).not.toHaveBeenCalled()
    expect(
      h.logs.warn.some((m) => m.includes('缺少 agentDefaultModel 服务')),
    ).toBe(true)
  })

  it('注册 handle dispose，并在 disposer 调用时释放', async () => {
    const h = createHarness()
    const effectSpy = vi.spyOn(h.ctx, 'effect')

    await ensureMain(h.ctx)

    const call = effectSpy.mock.calls.find((entry) => entry[1] === 'agent-base:main-dispose')
    expect(call).toBeDefined()
    const disposer = (call![0] as () => () => void)()
    disposer()
    expect(h.dispose).toHaveBeenCalledTimes(1)
  })
})
