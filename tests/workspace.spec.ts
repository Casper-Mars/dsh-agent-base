/**
 * `resolveFixedWorkspace` / `apply` / `Config` 的单元测试。
 *
 * 覆盖：相对路径、空值与空白、目录不存在（createWorkspaceDir 两种取值）、
 * 符号链接 canonical 化、同路径重复注册幂等、process.chdir 无关性、
 * `apply` 的错误包装与服务发布、Config schema 的 mainSessionId 非空约束。
 *
 * `resolveFixedWorkspace` 使用真实 `node:fs/promises` 与临时目录
 * （mkdtemp + rm），fake registry 记录 registry 实际收到的路径；
 * `apply` 用例使用真实 Cordis `Context`，验证 `ctx.agentBase` 服务。
 */
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { Config } from '../src/config.js'
import type { Config as AgentBaseConfig } from '../src/config.js'
import { AgentBaseService, apply } from '../src/index.js'
import { AgentBaseConfigError, resolveFixedWorkspace } from '../src/workspace.js'
import type { FixedWorkspaceRegistry } from '../src/workspace.js'

/** 每个用例创建的临时目录，afterEach 统一清理。 */
const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agent-base-'))
  tempDirs.push(dir)
  return dir
}

/** fake registry 类型：`create` 额外保留 vi.fn 的断言能力。 */
type FakeRegistry = FixedWorkspaceRegistry & { create: ReturnType<typeof vi.fn<FixedWorkspaceRegistry['create']>> }

/** 极简幂等 registry：按传入路径（本包保证是 canonical）复用同一实体。 */
function createFakeRegistry(): FakeRegistry {
  const byPath = new Map<string, Workspace>()
  const create = vi.fn(async (workspacePath: string): Promise<Workspace> => {
    const existing = byPath.get(workspacePath)
    if (existing !== undefined) return existing
    const workspace = {
      id: `ws-${byPath.size + 1}`,
      path: workspacePath,
      title: path.basename(workspacePath),
    } as unknown as Workspace
    byPath.set(workspacePath, workspace)
    return workspace
  })
  return { create }
}

/** 真实 Context：提供 `apply` 需要的三个服务（仅 registry 被实际读取）。 */
function createCtx(registry: FixedWorkspaceRegistry): Context {
  const ctx = new Context()
  ctx.provide('workspaceRegistry' as never, registry as never)
  ctx.provide('sessionPersistence' as never, {} as never)
  ctx.provide('agents' as never, {} as never)
  return ctx
}

const configOf = (overrides: Partial<AgentBaseConfig>): AgentBaseConfig => ({
  workspace: '/tmp/unset',
  mainSessionId: 'main',
  ...overrides,
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('resolveFixedWorkspace', () => {
  it('拒绝相对路径，错误包含原值且不调用 registry', async () => {
    const registry = createFakeRegistry()
    await expect(resolveFixedWorkspace({ workspace: 'relative/ws' }, { registry }))
      .rejects.toBeInstanceOf(AgentBaseConfigError)
    await expect(resolveFixedWorkspace({ workspace: 'relative/ws' }, { registry }))
      .rejects.toThrow(/'relative\/ws'/)
    expect(registry.create).not.toHaveBeenCalled()
  })

  it('拒绝空值与纯空白，错误包含原值', async () => {
    const registry = createFakeRegistry()
    await expect(resolveFixedWorkspace({ workspace: '' }, { registry }))
      .rejects.toThrow(/''/)
    await expect(resolveFixedWorkspace({ workspace: '   ' }, { registry }))
      .rejects.toThrow(/'   '/)
    expect(registry.create).not.toHaveBeenCalled()
  })

  it('createWorkspaceDir 为 true（默认）时自动创建缺失目录，registry 收到 canonical 路径', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'nested', 'ws')
    const registry = createFakeRegistry()

    const workspace = await resolveFixedWorkspace({ workspace: target }, { registry })

    const canonical = await realpath(target)
    expect(registry.create).toHaveBeenCalledTimes(1)
    expect(registry.create).toHaveBeenCalledWith(canonical)
    expect(workspace.path).toBe(canonical)
  })

  it('createWorkspaceDir 为 false 且目录不存在时拒绝，错误包含路径', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'missing-ws')
    const registry = createFakeRegistry()

    const promise = resolveFixedWorkspace(
      { workspace: target, createWorkspaceDir: false },
      { registry },
    )
    await expect(promise).rejects.toBeInstanceOf(AgentBaseConfigError)
    await expect(
      resolveFixedWorkspace({ workspace: target, createWorkspaceDir: false }, { registry }),
    ).rejects.toThrow(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    expect(registry.create).not.toHaveBeenCalled()
  })

  it('符号链接解析为目标的 canonical 路径，而不是链接路径', async () => {
    const base = await makeTempDir()
    const realDir = path.join(base, 'real-ws')
    const linkPath = path.join(base, 'link-ws')
    await mkdir(realDir, { recursive: true })
    await symlink(realDir, linkPath)
    const registry = createFakeRegistry()

    const workspace = await resolveFixedWorkspace({ workspace: linkPath }, { registry })

    const canonical = await realpath(realDir)
    expect(registry.create).toHaveBeenCalledWith(canonical)
    expect(workspace.path).toBe(canonical)
    expect(workspace.path).not.toBe(linkPath)
  })

  it('同一路径重复解析返回同一 workspace id（registry 按 canonical 幂等）', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    await mkdir(target, { recursive: true })
    const registry = createFakeRegistry()

    const first = await resolveFixedWorkspace({ workspace: target }, { registry })
    const second = await resolveFixedWorkspace({ workspace: target }, { registry })

    expect(second.id).toBe(first.id)
    expect(registry.create).toHaveBeenCalledTimes(2)
  })

  it('结果与 process.cwd() 无关：chdir 后同一绝对路径仍是同一 id，相对路径仍被拒绝', async () => {
    const base = await makeTempDir()
    const otherCwd = await makeTempDir()
    const target = path.join(base, 'ws')
    await mkdir(target, { recursive: true })
    const registry = createFakeRegistry()

    const before = await resolveFixedWorkspace({ workspace: target }, { registry })

    const originalCwd = process.cwd()
    try {
      process.chdir(otherCwd)
      const after = await resolveFixedWorkspace({ workspace: target }, { registry })
      expect(after.id).toBe(before.id)

      // 没有 cwd 兜底：相对路径在 chdir 之后仍然失败，且不会落到 otherCwd 下。
      await expect(resolveFixedWorkspace({ workspace: 'ws' }, { registry }))
        .rejects.toThrow(/must be an absolute path/)
    } finally {
      process.chdir(originalCwd)
    }
  })
})

describe('apply', () => {
  it('相对路径配置启动失败，错误包含原值且不发布服务', async () => {
    const registry = createFakeRegistry()
    const ctx = createCtx(registry)

    await expect(apply(ctx, configOf({ workspace: 'relative/ws' })))
      .rejects.toThrow(/'relative\/ws'/)
    expect(ctx.get('agentBase')).toBeUndefined()
  })

  it('合法配置发布 ctx.agentBase，值为 canonical workspaceCwd 与配置 mainSessionId', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    const registry = createFakeRegistry()
    const ctx = createCtx(registry)

    await apply(ctx, configOf({ workspace: target, mainSessionId: 'main' }))

    const service = ctx.get('agentBase')
    expect(service).toBeInstanceOf(AgentBaseService)
    expect(service?.workspaceCwd).toBe(await realpath(target))
    expect(service?.mainSessionId).toBe('main')
  })

  it('registry 抛错被包装为 AgentBaseConfigError，message 含原配置路径且不发布服务', async () => {
    const base = await makeTempDir()
    const target = path.join(base, 'ws')
    await mkdir(target, { recursive: true })
    const registry: FixedWorkspaceRegistry = {
      create: async () => {
        throw new Error('storage exploded')
      },
    }
    const ctx = createCtx(registry)

    const promise = apply(ctx, configOf({ workspace: target }))
    await expect(promise).rejects.toBeInstanceOf(AgentBaseConfigError)
    await expect(apply(ctx, configOf({ workspace: target })))
      .rejects.toThrow(/storage exploded/)
    expect(ctx.get('agentBase')).toBeUndefined()
  })
})

describe('Config schema', () => {
  it('mainSessionId 为空时校验失败', () => {
    expect(() => Config({ workspace: '/tmp/ws', mainSessionId: '' })).toThrow()
  })

  it('合法配置通过，两个 boolean 缺省为 true', () => {
    const parsed = Config({ workspace: '/tmp/ws', mainSessionId: 'main' }) as AgentBaseConfig
    expect(parsed.workspace).toBe('/tmp/ws')
    expect(parsed.mainSessionId).toBe('main')
    expect(parsed.createWorkspaceDir).toBe(true)
    expect(parsed.validateExistingMain).toBe(true)
  })
})
