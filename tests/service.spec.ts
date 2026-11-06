/**
 * `AgentBaseService`（`ctx.agentBase`）的边界与生命周期测试。
 *
 * 使用真实 Cordis `Context` 与真实 `apply`，只对 registry / agents /
 * workspace 的外部副作用使用 spy。覆盖：
 *   - `ctx.get('agentBase')` 可用且两个值与 canonical workspace、配置一致；
 *   - 服务无 ensure / deliver / bind / status，且不创建/恢复 Agent、不 attachSession；
 *   - 实例只有两个只读属性（外加 Service 基类的 ctx / name），无额外公共方法；
 *   - `ctx.fiber.dispose()` 后服务不可用；
 *   - 新 Context 重载相同配置后两个值一致。
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { AgentBaseService, apply } from '../src/index.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agent-base-svc-'))
  tempDirs.push(dir)
  return dir
}

interface Spies {
  workspaceAttachSession: ReturnType<typeof vi.fn>
  agentCreate: ReturnType<typeof vi.fn>
  agentResume: ReturnType<typeof vi.fn>
  agentGet: ReturnType<typeof vi.fn>
  sessionStat: ReturnType<typeof vi.fn>
}

interface Harness {
  ctx: Context
  spies: Spies
  registryCreate: ReturnType<typeof vi.fn>
}

/** 构造真实 Context + 三个 inject 服务；workspace 带 attachSession spy。 */
function createHarness(): Harness {
  const spies: Spies = {
    workspaceAttachSession: vi.fn(),
    agentCreate: vi.fn(),
    agentResume: vi.fn(),
    agentGet: vi.fn(() => undefined),
    sessionStat: vi.fn(async () => undefined),
  }
  const registryCreate = vi.fn(async (workspacePath: string): Promise<Workspace> => ({
    id: 'ws-1',
    path: workspacePath,
    title: path.basename(workspacePath),
    attachSession: spies.workspaceAttachSession,
  }) as unknown as Workspace)

  const ctx = new Context()
  ctx.provide('workspaceRegistry' as never, { create: registryCreate } as never)
  ctx.provide('sessionPersistence' as never, { stat: spies.sessionStat } as never)
  ctx.provide('agents' as never, {
    get: spies.agentGet,
    create: spies.agentCreate,
    resume: spies.agentResume,
  } as never)

  return { ctx, spies, registryCreate }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('AgentBaseService', () => {
  it('真实 Context 中通过 ctx.get 暴露 canonical workspaceCwd 与配置 mainSessionId', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    const { ctx } = createHarness()

    await apply(ctx, { workspace: target, mainSessionId: 'main' })

    const service = ctx.get('agentBase')
    expect(service).toBeInstanceOf(AgentBaseService)
    expect(service?.workspaceCwd).toBe(await realpath(target))
    expect(service?.mainSessionId).toBe('main')
  })

  it('不提供 ensure / deliver / bind / status，也没有额外公共方法', async () => {
    const base = await makeTempDir()
    const { ctx } = createHarness()
    await apply(ctx, { workspace: path.join(base, 'ws'), mainSessionId: 'main' })

    const service = ctx.agentBase as AgentBaseService
    for (const forbidden of ['ensure', 'deliver', 'bind', 'status'] as const) {
      expect(forbidden in service).toBe(false)
    }

    // 子类原型不新增任何方法；公开面只有两个只读属性 + 基类的 ctx / name。
    const protoKeys = Object.getOwnPropertyNames(AgentBaseService.prototype).sort()
    expect(protoKeys).toEqual(['constructor'])

    const instanceKeys = Object.getOwnPropertyNames(service).sort()
    expect(instanceKeys).toEqual(['ctx', 'mainSessionId', 'name', 'workspaceCwd'])
    for (const key of ['workspaceCwd', 'mainSessionId'] as const) {
      const desc = Object.getOwnPropertyDescriptor(service, key)
      expect(desc?.writable).toBe(false)
      expect(desc?.configurable).toBe(false)
    }
  })

  it('缺少 preset / 模型服务时后台 ensure 降级：不创建/恢复 Agent，也不 attachSession', async () => {
    const base = await makeTempDir()
    const { ctx, spies, registryCreate } = createHarness()

    await apply(ctx, { workspace: path.join(base, 'ws'), mainSessionId: 'main' })

    expect(registryCreate).toHaveBeenCalledTimes(1)
    expect(spies.agentCreate).not.toHaveBeenCalled()
    expect(spies.agentResume).not.toHaveBeenCalled()
    expect(spies.workspaceAttachSession).not.toHaveBeenCalled()
    // 无 main session 时仅做了只读探测，没有创建任何东西。
    expect(spies.agentGet).toHaveBeenCalledWith('main')
    expect(spies.sessionStat).toHaveBeenCalledWith('main')
  })

  it('owner fiber dispose 后 ctx.get("agentBase") 为 undefined', async () => {
    const base = await makeTempDir()
    const { ctx } = createHarness()
    await apply(ctx, { workspace: path.join(base, 'ws'), mainSessionId: 'main' })
    expect(ctx.get('agentBase')).toBeInstanceOf(AgentBaseService)

    await ctx.fiber.dispose()

    expect(ctx.get('agentBase')).toBeUndefined()
  })

  it('新 Context 重载相同配置后两个值保持一致', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    const first = createHarness()
    await apply(first.ctx, { workspace: target, mainSessionId: 'main' })

    const second = createHarness()
    await apply(second.ctx, { workspace: target, mainSessionId: 'main' })

    const canonical = await realpath(target)
    expect(second.ctx.agentBase.workspaceCwd).toBe(canonical)
    expect(second.ctx.agentBase.workspaceCwd).toBe(first.ctx.agentBase.workspaceCwd)
    expect(second.ctx.agentBase.mainSessionId).toBe('main')
    expect(second.ctx.agentBase.mainSessionId).toBe(first.ctx.agentBase.mainSessionId)

    await first.ctx.fiber.dispose()
    await second.ctx.fiber.dispose()
  })
})
