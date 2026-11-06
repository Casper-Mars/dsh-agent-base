/**
 * `scheduleEnsureAfterBoot`（main session 准备延迟到宿主加载完成）的测试。
 *
 * 覆盖：
 *   1. `loader.await` 未 resolve 前不创建 / 恢复，resolve 后才创建；
 *   2. `apply` 同步返回：即使 `loader.await` 永不 resolve，apply 也不挂起；
 *   3. loader 缺失 → 走 `queueMicrotask`，最终仍创建；
 *   4. `loader.await` reject → 仍然执行 ensure；
 *   5. apply 自身 entry 未完成时不死锁（loader 在 apply 返回后才 resolve）；
 *   6. 幂等：多次调度仍只 create 一次。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBaseService } from '../src/service.js'
import { apply } from '../src/index.js'
import { scheduleEnsureAfterBoot } from '../src/ensure-main.js'

const contexts: Context[] = []
const tempDirs: string[] = []

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

/** 让出若干个宏任务，排空 microtask / setImmediate 回调。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Spies {
  get: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  attachSession: ReturnType<typeof vi.fn>
}

interface Harness {
  ctx: Context
  spies: Spies
}

interface HarnessOptions {
  /** 可选 loader 服务；`undefined` 表示不提供。 */
  loader?: unknown
  /** 是否由 harness 直接发布 `agentBase`（走真实 `apply` 时设为 false）。 */
  withService?: boolean
}

/** 注入准备 main session 所需的最小服务；不访问真实磁盘。 */
function createHarness(options: HarnessOptions = {}): Harness {
  const ctx = new Context()
  contexts.push(ctx)

  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  })

  const attachSession = vi.fn(async () => {})
  const spies: Spies = {
    get: vi.fn(() => undefined),
    create: vi.fn(async () => ({ agent: { id: 'main' }, dispose: vi.fn() })),
    resume: vi.fn(async () => ({ agent: { id: 'main' }, dispose: vi.fn() })),
    stat: vi.fn(async () => undefined),
    attachSession,
  }

  ctx.provide('agents' as never, {
    get: spies.get,
    create: spies.create,
    resume: spies.resume,
  } as never)
  ctx.provide('sessionPersistence' as never, { stat: spies.stat } as never)
  ctx.provide('workspaceRegistry' as never, {
    create: vi.fn(async (workspacePath: string) => ({
      id: 'ws-1',
      path: workspacePath,
      title: path.basename(workspacePath),
      attachSession,
    })),
  } as never)
  ctx.provide('agentPresets' as never, {
    resolve: vi.fn(async () => ({ id: 'default' })),
    mount: vi.fn(async () => {}),
  } as never)
  ctx.provide('agentDefaultModel' as never, {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  } as never)

  if (options.loader !== undefined) {
    ctx.provide('loader' as never, options.loader as never)
  }

  if (options.withService !== false) {
    new AgentBaseService(ctx, { workspaceCwd: '/ws', mainSessionId: 'main' as never })
  }

  return { ctx, spies }
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agent-base-boot-'))
  tempDirs.push(dir)
  return dir
}

describe('scheduleEnsureAfterBoot', () => {
  it('loader.await 未 resolve 前不创建，resolve 后才创建', async () => {
    const gate = deferred()
    const { ctx, spies } = createHarness({ loader: { await: () => gate.promise } })

    scheduleEnsureAfterBoot(ctx, 1_000)
    await flush()

    expect(spies.get).not.toHaveBeenCalled()
    expect(spies.create).not.toHaveBeenCalled()
    expect(spies.resume).not.toHaveBeenCalled()

    gate.resolve()
    await flush()

    expect(spies.get).toHaveBeenCalledTimes(1)
    expect(spies.create).toHaveBeenCalledTimes(1)
    expect(spies.resume).not.toHaveBeenCalled()
    expect(spies.attachSession).toHaveBeenCalledTimes(1)
  })

  it('apply 同步返回：loader.await 永不 resolve 时 apply 也不挂起', async () => {
    const base = await makeTempDir()
    const gate = deferred()
    const { ctx, spies } = createHarness({ loader: { await: () => gate.promise }, withService: false })

    const started = Date.now()
    await apply(ctx, {
      workspace: path.join(base, 'ws'),
      mainSessionId: 'main',
      scheduler: { enabled: false },
    })
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(50)
    expect(spies.create).not.toHaveBeenCalled()
    expect(spies.resume).not.toHaveBeenCalled()
  })

  it('loader 缺失时走 queueMicrotask，最终仍创建', async () => {
    const { ctx, spies } = createHarness()

    scheduleEnsureAfterBoot(ctx, 1_000)
    // 同步阶段不应有任何准备动作。
    expect(spies.create).not.toHaveBeenCalled()

    await flush()

    expect(spies.create).toHaveBeenCalledTimes(1)
  })

  it('loader.await reject 时仍然执行 ensure', async () => {
    const { ctx, spies } = createHarness({
      loader: { await: () => Promise.reject(new Error('loader exploded')) },
    })

    scheduleEnsureAfterBoot(ctx, 1_000)
    await flush()

    expect(spies.create).toHaveBeenCalledTimes(1)
  })

  it('apply 自身 entry 未完成时不死锁：loader 在 apply 返回后才 resolve', async () => {
    const base = await makeTempDir()
    const boot = deferred()
    const { ctx, spies } = createHarness({ loader: { await: () => boot.promise }, withService: false })

    await apply(ctx, {
      workspace: path.join(base, 'ws'),
      mainSessionId: 'main',
      scheduler: { enabled: false },
    })

    // apply 已返回，但模拟中的宿主 entry 仍未加载完成。
    expect(spies.create).not.toHaveBeenCalled()

    boot.resolve()
    await flush()

    expect(spies.create).toHaveBeenCalledTimes(1)
  })

  it('幂等：多次调度仍只 create 一次', async () => {
    const { ctx, spies } = createHarness({
      loader: { await: async () => {} },
    })

    scheduleEnsureAfterBoot(ctx, 1_000)
    scheduleEnsureAfterBoot(ctx, 1_000)
    scheduleEnsureAfterBoot(ctx, 1_000)
    await flush()

    expect(spies.create).toHaveBeenCalledTimes(1)
  })
})
