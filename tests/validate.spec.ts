/**
 * `validateExistingMain` 的守卫语义测试。
 *
 * 分两层：
 *   1. 纯函数层——注入 fake `agents` / `sessionPersistence` / `fs`，逐条覆盖
 *      校验顺序（live 优先 → persisted → 都不存在）、开关短路、canonical 比较与失败类型；
 *   2. 集成层——真实 Cordis `Context` + 真实 `apply` + 真实临时目录/symlink，
 *      证明失败发生在 service 注册之前，且任何路径都不创建/恢复 Agent。
 *
 * 贯穿全程的硬约束断言：`agents.create` / `agents.resume` /
 * `workspace.attachSession` 一次都不允许被调用。
 */
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  AgentBaseService,
  AgentBaseValidationError,
  AgentBaseWorkspaceMismatchError,
  apply,
  validateExistingMain,
} from '../src/index.js'
import type { ValidateExistingMainDeps } from '../src/index.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agent-base-val-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** 与 Service 无关的副作用集合：任何校验路径都不得触碰。 */
interface ForbiddenSpies {
  agentCreate: ReturnType<typeof vi.fn>
  agentResume: ReturnType<typeof vi.fn>
  workspaceAttachSession: ReturnType<typeof vi.fn>
}

function makeForbidden(): ForbiddenSpies {
  return {
    agentCreate: vi.fn(),
    agentResume: vi.fn(),
    workspaceAttachSession: vi.fn(),
  }
}

function expectNoMutation(spies: ForbiddenSpies): void {
  expect(spies.agentCreate).not.toHaveBeenCalled()
  expect(spies.agentResume).not.toHaveBeenCalled()
  expect(spies.workspaceAttachSession).not.toHaveBeenCalled()
}

/** 纯函数层的依赖替身。 */
interface UnitDeps {
  deps: ValidateExistingMainDeps
  agentGet: ReturnType<typeof vi.fn>
  sessionStat: ReturnType<typeof vi.fn>
  fsRealpath: ReturnType<typeof vi.fn>
  forbidden: ForbiddenSpies
}

function makeUnitDeps(options: {
  live?: unknown
  snapshot?: unknown
  statError?: unknown
  realpathError?: unknown
} = {}): UnitDeps {
  const forbidden = makeForbidden()
  const agentGet = vi.fn(() => options.live)
  const sessionStat = vi.fn(async () => {
    if (options.statError !== undefined) throw options.statError
    return options.snapshot
  })
  const fsRealpath = vi.fn(async (target: string) => {
    if (options.realpathError !== undefined) throw options.realpathError
    return target
  })

  return {
    deps: {
      agents: { get: agentGet },
      sessionPersistence: { stat: sessionStat },
      fs: { realpath: fsRealpath },
    },
    agentGet,
    sessionStat,
    fsRealpath,
    forbidden,
  }
}

/** 构造一个 live Agent 形状：只暴露 session.header.cwd。 */
function liveAgent(cwd?: string): { session: { header: { cwd?: string } } } {
  return { session: { header: cwd === undefined ? {} : { cwd } } }
}

const WS = '/srv/fixed-workspace'

describe('validateExistingMain：开关与"不存在"分支', () => {
  it('validateExistingMain=false 时直接通过，不调用 agents.get 也不 stat', async () => {
    const { deps, agentGet, sessionStat, forbidden } = makeUnitDeps({
      live: liveAgent('/elsewhere'),
      statError: new Error('should not be called'),
    })

    await expect(validateExistingMain(
      { mainSessionId: 'main', workspaceCwd: WS, validateExistingMain: false },
      deps,
    )).resolves.toBeUndefined()

    expect(agentGet).not.toHaveBeenCalled()
    expect(sessionStat).not.toHaveBeenCalled()
    expectNoMutation(forbidden)
  })

  it('live 与 persisted 都不存在时通过，且不创建任何 session', async () => {
    const { deps, agentGet, sessionStat, forbidden } = makeUnitDeps({ snapshot: undefined })

    await expect(validateExistingMain({ mainSessionId: 'main', workspaceCwd: WS }, deps))
      .resolves.toBeUndefined()

    expect(agentGet).toHaveBeenCalledExactlyOnceWith('main')
    expect(sessionStat).toHaveBeenCalledExactlyOnceWith('main')
    expectNoMutation(forbidden)
  })

  it('省略 validateExistingMain 等价于开启（默认校验）', async () => {
    const { deps, sessionStat } = makeUnitDeps({ snapshot: undefined })

    await validateExistingMain({ mainSessionId: 'main', workspaceCwd: WS }, deps)

    expect(sessionStat).toHaveBeenCalledTimes(1)
  })
})

describe('validateExistingMain：live session 命中', () => {
  it('cwd 与 workspace 字符串相等时通过，且不再查持久化（不 stat）', async () => {
    const { deps, sessionStat, fsRealpath, forbidden } = makeUnitDeps({ live: liveAgent(WS) })

    await expect(validateExistingMain({ mainSessionId: 'main', workspaceCwd: WS }, deps))
      .resolves.toBeUndefined()

    expect(sessionStat).not.toHaveBeenCalled()
    expect(fsRealpath).not.toHaveBeenCalled()
    expectNoMutation(forbidden)
  })

  it('cwd 不匹配时抛 Mismatch，字段与 message 同时含实际值与期望值', async () => {
    const actual = '/srv/other-workspace'
    const { deps, sessionStat, forbidden } = makeUnitDeps({ live: liveAgent(actual) })

    const error = await validateExistingMain(
      { mainSessionId: 'main', workspaceCwd: WS },
      deps,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentBaseWorkspaceMismatchError)
    const mismatch = error as AgentBaseWorkspaceMismatchError
    expect(mismatch.name).toBe('AgentBaseWorkspaceMismatchError')
    expect(mismatch.mainSessionId).toBe('main')
    expect(mismatch.expectedCwd).toBe(WS)
    expect(mismatch.actualCwd).toBe(actual)
    expect(mismatch.message).toContain(actual)
    expect(mismatch.message).toContain(WS)
    // live 已是权威事实，不再查持久化。
    expect(sessionStat).not.toHaveBeenCalled()
    expectNoMutation(forbidden)
  })

  it('live cwd 是期望路径的 symlink 拼写时，realpath 归一后通过', async () => {
    const link = '/srv/fixed-workspace-link'
    const { deps, fsRealpath } = makeUnitDeps({ live: liveAgent(link) })
    fsRealpath.mockImplementation(async () => WS)

    await expect(validateExistingMain({ mainSessionId: 'main', workspaceCwd: WS }, deps))
      .resolves.toBeUndefined()

    expect(fsRealpath).toHaveBeenCalledExactlyOnceWith(link)
  })

  it('live 命中但 header 无 cwd 时抛 Mismatch，actualCwd 为 undefined 且 message 有说明', async () => {
    const { deps } = makeUnitDeps({ live: liveAgent() })

    const error = await validateExistingMain(
      { mainSessionId: 'main', workspaceCwd: WS },
      deps,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentBaseWorkspaceMismatchError)
    const mismatch = error as AgentBaseWorkspaceMismatchError
    expect(mismatch.actualCwd).toBeUndefined()
    expect(mismatch.message).toContain('<none>')
    expect(mismatch.message).toContain(WS)
  })

  it('realpath 失败视为不匹配，而不是静默通过', async () => {
    const { deps } = makeUnitDeps({
      live: liveAgent('/srv/gone-away'),
      realpathError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    })

    await expect(validateExistingMain({ mainSessionId: 'main', workspaceCwd: WS }, deps))
      .rejects.toBeInstanceOf(AgentBaseWorkspaceMismatchError)
  })
})

describe('validateExistingMain：persisted session 命中', () => {
  it('cwd 匹配时通过', async () => {
    const { deps, forbidden } = makeUnitDeps({
      live: undefined,
      snapshot: { header: { cwd: WS }, revision: 'r1' },
    })

    await expect(validateExistingMain({ mainSessionId: 'main', workspaceCwd: WS }, deps))
      .resolves.toBeUndefined()

    expectNoMutation(forbidden)
  })

  it('cwd 不匹配时抛 Mismatch，字段与 message 同时含实际值与期望值', async () => {
    const actual = '/srv/legacy-workspace'
    const { deps } = makeUnitDeps({
      snapshot: { header: { cwd: actual }, revision: 'r1' },
    })

    const error = await validateExistingMain(
      { mainSessionId: 'main', workspaceCwd: WS },
      deps,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentBaseWorkspaceMismatchError)
    const mismatch = error as AgentBaseWorkspaceMismatchError
    expect(mismatch.mainSessionId).toBe('main')
    expect(mismatch.expectedCwd).toBe(WS)
    expect(mismatch.actualCwd).toBe(actual)
    expect(mismatch.message).toContain(actual)
    expect(mismatch.message).toContain(WS)
  })

  it('persisted header 无 cwd 时抛 Mismatch，actualCwd 为 undefined', async () => {
    const { deps } = makeUnitDeps({ snapshot: { header: {}, revision: 'r1' } })

    const error = await validateExistingMain(
      { mainSessionId: 'main', workspaceCwd: WS },
      deps,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentBaseWorkspaceMismatchError)
    expect((error as AgentBaseWorkspaceMismatchError).actualCwd).toBeUndefined()
    expect((error as AgentBaseWorkspaceMismatchError).message).toContain('<none>')
  })

  it('persisted cwd 是 symlink 拼写时经 realpath 归一后通过', async () => {
    const link = '/srv/legacy-link'
    const { deps, fsRealpath } = makeUnitDeps({
      snapshot: { header: { cwd: link }, revision: 'r1' },
    })
    fsRealpath.mockImplementation(async () => WS)

    await expect(validateExistingMain({ mainSessionId: 'main', workspaceCwd: WS }, deps))
      .resolves.toBeUndefined()

    expect(fsRealpath).toHaveBeenCalledExactlyOnceWith(link)
  })
})

describe('validateExistingMain：校验失败（stat 抛错）', () => {
  it('stat 抛错时抛 ValidationError，cause 为原始错误且 message 含 mainSessionId', async () => {
    const original = Object.assign(new Error('disk on fire'), { code: 'EIO' })
    const { deps, forbidden } = makeUnitDeps({ statError: original })

    const error = await validateExistingMain(
      { mainSessionId: 'main', workspaceCwd: WS },
      deps,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentBaseValidationError)
    const validation = error as AgentBaseValidationError
    expect(validation.name).toBe('AgentBaseValidationError')
    expect(validation.mainSessionId).toBe('main')
    expect(validation.cause).toBe(original)
    expect(validation.message).toContain('main')
    expectNoMutation(forbidden)
  })

  it('validateExistingMain=false 时即使 stat 会抛错也直接通过', async () => {
    const { deps, agentGet, sessionStat } = makeUnitDeps({
      statError: new Error('never read'),
    })

    await expect(validateExistingMain(
      { mainSessionId: 'main', workspaceCwd: WS, validateExistingMain: false },
      deps,
    )).resolves.toBeUndefined()

    expect(agentGet).not.toHaveBeenCalled()
    expect(sessionStat).not.toHaveBeenCalled()
  })
})

describe('apply 集成：校验时机与失败语义', () => {
  interface Harness {
    ctx: Context
    spies: ForbiddenSpies
    sessionStat: ReturnType<typeof vi.fn>
    agentGet: ReturnType<typeof vi.fn>
  }

  function createHarness(options: {
    live?: unknown
    snapshot?: unknown
    statError?: unknown
  } = {}): Harness {
    const spies = makeForbidden()
    const agentGet = vi.fn(() => options.live)
    const sessionStat = vi.fn(async () => {
      if (options.statError !== undefined) throw options.statError
      return options.snapshot
    })

    const ctx = new Context()
    ctx.provide('workspaceRegistry' as never, {
      create: vi.fn(async (workspacePath: string): Promise<Workspace> => ({
        id: 'ws-1',
        path: workspacePath,
        title: path.basename(workspacePath),
        attachSession: spies.workspaceAttachSession,
      }) as unknown as Workspace),
    } as never)
    ctx.provide('sessionPersistence' as never, { stat: sessionStat } as never)
    ctx.provide('agents' as never, {
      get: agentGet,
      create: spies.agentCreate,
      resume: spies.agentResume,
    } as never)

    return { ctx, spies, sessionStat, agentGet }
  }

  it('无 main session 时 apply 成功，service 已注册，且未创建任何 session', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    const { ctx, spies, sessionStat, agentGet } = createHarness()

    await apply(ctx, { workspace: target, mainSessionId: 'main' })

    expect(ctx.get('agentBase')).toBeInstanceOf(AgentBaseService)
    expect(ctx.agentBase.workspaceCwd).toBe(await realpath(target))
    expect(agentGet).toHaveBeenCalledWith('main')
    expect(sessionStat).toHaveBeenCalledWith('main')
    expectNoMutation(spies)
  })

  it('live cwd 不匹配时 apply 抛 Mismatch，且 service 未注册', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    const actual = path.join(base, 'other')
    await mkdir(actual, { recursive: true })
    const { ctx, spies } = createHarness({ live: liveAgent(actual) })

    const error = await apply(ctx, { workspace: target, mainSessionId: 'main' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentBaseWorkspaceMismatchError)
    expect((error as AgentBaseWorkspaceMismatchError).actualCwd).toBe(actual)
    expect((error as AgentBaseWorkspaceMismatchError).expectedCwd).toBe(await realpath(target))
    expect(ctx.get('agentBase')).toBeUndefined()
    expectNoMutation(spies)
  })

  it('persisted cwd 不匹配时 apply 抛 Mismatch，message 含 expected 与 actual', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    const actual = path.join(base, 'legacy')
    const { ctx, spies } = createHarness({ snapshot: { header: { cwd: actual }, revision: 'r1' } })

    const error = await apply(ctx, { workspace: target, mainSessionId: 'main' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentBaseWorkspaceMismatchError)
    const expected = await realpath(target)
    expect((error as Error).message).toContain(actual)
    expect((error as Error).message).toContain(expected)
    expect(ctx.get('agentBase')).toBeUndefined()
    expectNoMutation(spies)
  })

  it('真实 symlink 的 persisted cwd 指向 workspace 时 apply 通过', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    await mkdir(target, { recursive: true })
    const canonical = await realpath(target)
    const link = path.join(base, 'ws-link')
    await symlink(canonical, link)

    const { ctx, spies } = createHarness({ snapshot: { header: { cwd: link }, revision: 'r1' } })
    await apply(ctx, { workspace: target, mainSessionId: 'main' })

    expect(ctx.agentBase.workspaceCwd).toBe(canonical)
    expectNoMutation(spies)
  })

  it('stat 抛错时 apply 抛 ValidationError（保留 cause），service 未注册', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    const original = new Error('persistence offline')
    const { ctx, spies } = createHarness({ statError: original })

    const error = await apply(ctx, { workspace: target, mainSessionId: 'main' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentBaseValidationError)
    expect((error as AgentBaseValidationError).cause).toBe(original)
    expect((error as Error).message).toContain('main')
    expect(ctx.get('agentBase')).toBeUndefined()
    expectNoMutation(spies)
  })

  it('validateExistingMain=false 时跳过校验：cwd 不一致也不失败，apply 成功', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    const original = new Error('persistence offline')
    const { ctx, spies } = createHarness({
      live: liveAgent('/elsewhere'),
      statError: original,
    })

    await apply(ctx, {
      workspace: target,
      mainSessionId: 'main',
      validateExistingMain: false,
    })

    expect(ctx.agentBase.workspaceCwd).toBe(await realpath(target))
    // 启动期校验被跳过：不会因 live session 的 cwd 不一致而失败。
    // 后台 ensure 会独立做只读探测，但不属于启动期校验，也不修改任何会话。
    expectNoMutation(spies)
  })
})
