/**
 * 固定 Workspace 的解析：绝对路径校验 → 目录准备 → canonical 化 → 注册。
 *
 * 设计要点：
 *   - 固定目录只有一个来源：插件配置 `config.workspace`；
 *   - 绝不使用进程当前目录 / registry 首项 / 某个 session 的 cwd 兜底；
 *   - 绝不用路径拼接把相对路径悄悄变成绝对路径 —— 相对路径在
 *     绝对路径校验阶段直接拒绝，错误信息保留原值；
 *   - `WorkspaceRegistry.create()` 内部会再 realpath 一次，本模块传入的是
 *     已 canonical 的路径，二次 realpath 幂等，同时保证 registry 收到的
 *     就是最终 canonical path。
 *
 * 本模块是纯函数式核心（依赖通过参数注入），`index.ts` 的 `apply` 只做
 * 依赖注入、状态保存与错误转换，便于单测覆盖全部分支。
 */
import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Config } from './config.js'

/** `resolveFixedWorkspace` 需要读取的配置子集。 */
export type ResolveFixedWorkspaceConfig = Pick<Config, 'workspace' | 'createWorkspaceDir'>

/**
 * 文件系统能力（可注入）。与 `node:fs/promises` 的对应方法签名保持兼容，
 * 测试可替换为 fake 以覆盖 mkdir / realpath 失败分支。
 */
export interface FixedWorkspaceFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  realpath(path: string): Promise<string>
}

/** 只读的 workspace 注册表能力：按 canonical path 幂等创建/复用。 */
export interface FixedWorkspaceRegistry {
  create(path: string): Promise<Workspace>
}

/** `resolveFixedWorkspace` 的依赖。 */
export interface ResolveFixedWorkspaceDeps {
  readonly registry: FixedWorkspaceRegistry
  /** 测试注入；默认 `node:fs/promises`。 */
  readonly fs?: FixedWorkspaceFs
}

/** 默认文件系统实现。 */
const defaultFs: FixedWorkspaceFs = {
  mkdir: (target, options) => mkdir(target, options),
  realpath: target => realpath(target),
}

/**
 * 固定 Workspace 配置错误。
 *
 * 所有「目录没准备好 / 路径不合法」的失败都归一到这个类型，`workspace`
 * 字段保留用户配置的原值，便于把原值写进日志和上层错误链。
 */
export class AgentBaseConfigError extends Error {
  readonly workspace: string

  constructor(message: string, workspace: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.name = 'AgentBaseConfigError'
    this.workspace = workspace
  }
}

/** 把任意值渲染成错误信息里的原值字面量。 */
const quote = (raw: unknown): string => `'${String(raw)}'`

/**
 * 将配置中的固定 workspace 解析为已注册的 canonical Workspace。
 *
 * 严格流程：
 *   1. 非空字符串校验（空白视为空）；
 *   2. 绝对路径校验（相对路径在此直接拒绝）；
 *   3. `createWorkspaceDir !== false` 时 `mkdir -p`；
 *   4. `realpath` 得到 canonical path（目录不存在在此失败）；
 *   5. `registry.create(canonical)`，按 canonical path 幂等复用。
 *
 * @param config - 插件配置子集。
 * @param deps - 注册表与（可选的）文件系统实现。
 * @returns 已注册的 Workspace（`path` 为 canonical path）。
 */
export async function resolveFixedWorkspace(
  config: ResolveFixedWorkspaceConfig,
  deps: ResolveFixedWorkspaceDeps,
): Promise<Workspace> {
  const fs = deps.fs ?? defaultFs
  const raw: unknown = config.workspace

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AgentBaseConfigError(
      `agent-base: config.workspace must be a non-empty absolute path, got ${quote(raw)}`,
      String(raw),
    )
  }

  if (!path.isAbsolute(raw)) {
    throw new AgentBaseConfigError(
      `agent-base: config.workspace must be an absolute path, got ${quote(raw)}`,
      raw,
    )
  }

  if (config.createWorkspaceDir !== false) {
    try {
      await fs.mkdir(raw, { recursive: true })
    } catch (error) {
      throw new AgentBaseConfigError(
        `agent-base: cannot create workspace directory ${quote(raw)}`,
        raw,
        { cause: error },
      )
    }
  }

  let canonical: string
  try {
    canonical = await fs.realpath(raw)
  } catch (error) {
    throw new AgentBaseConfigError(
      `agent-base: workspace directory ${quote(raw)} is not accessible`
        + (config.createWorkspaceDir === false ? ' (createWorkspaceDir is false)' : ''),
      raw,
      { cause: error },
    )
  }

  return await deps.registry.create(canonical)
}
