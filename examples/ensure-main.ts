/**
 * 示例：消费方插件如何把消息投递到 main session。
 *
 * ⚠️ 这是**示例代码**，不是 `dsh-agent-base` 的导出，也不在包的 `exports` 里。
 * 复制到自己的插件里使用；`dsh-agent-base` 只提供 `ctx.agentBase` 的两个只读值，
 * 不创建 main、不投递、不提供 `ensure`。
 *
 * 覆盖的链路：
 *   1. 显式 session 优先：调用方给了 sessionId 就不读 `ctx.agentBase`；
 *   2. 缺省时才读 `agentBase`：live 命中 → 直接复用；
 *   3. 未命中 → `sessionPersistence.stat` → 有快照则 `resume`，无快照则 `create` + `attachSession`；
 *   4. 最后 `followup`，`source` / `deliveryId` / single-flight 全部由消费方决定。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { realpath } from 'node:fs/promises'
// 仅为加载这两个包的 Context 模块增强（`ctx.agentPresets` / `ctx.agentDefaultModel`）。
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'
// 只为加载 `ctx.agentBase` 的模块增强；消费方在自己的包里同样只需 import 本包。
import type {} from 'dsh-agent-base'

/**
 * 投递来源由消费方自己声明：`kind` + 幂等键 + 展示形式。
 *
 * `MessageSourceMap` 是合并扩展的，base 不定义也不限制任何投递来源。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'example-dispatch': {
      kind: 'example-dispatch'
      /** 消费方自己的幂等键；base 不生成、不校验。 */
      deliveryId: string
    } & ContextFormed
  }
}

/** 显式 session 与 main session 两条路径共用的投递参数。 */
export interface DeliverInput {
  /** 消息正文。 */
  readonly text: string
  /** 消费方幂等键，写进消息 source。 */
  readonly deliveryId: string
  /** 只对「没有显式 session」的路径生效：main 首次创建时使用的 preset。 */
  readonly agentPreset?: string
  /** 显式 session：一旦给出就完全不读 `ctx.agentBase`。 */
  readonly sessionId?: SessionId
}

/**
 * single-flight：同一 Context、同一 session 上并发的 ensure 只跑一次。
 *
 * main 与显式 session 共用这张表：key 是 sessionId，因此两个并发的显式
 * `deliver({ sessionId })` 也只会调用一次 `resume`。
 *
 * base 不提供这个能力——并发保护是消费方的责任，否则两个 create/resume
 * 会有一个收到 already exists。
 */
const inflight = new WeakMap<Context, Map<SessionId, Promise<Agent>>>()

/** 对 `(ctx, sessionId)` 做 single-flight；任务结束后释放槽位。 */
function singleFlight(
  ctx: Context,
  sessionId: SessionId,
  run: () => Promise<Agent>,
): Promise<Agent> {
  let sessions = inflight.get(ctx)
  if (sessions === undefined) {
    sessions = new Map<SessionId, Promise<Agent>>()
    inflight.set(ctx, sessions)
  }
  const map = sessions

  const running = map.get(sessionId)
  if (running !== undefined) return running

  const task = run().finally(() => {
    if (map.get(sessionId) === task) map.delete(sessionId)
  })
  map.set(sessionId, task)
  return task
}

/**
 * canonical cwd 比较，语义与 `src/validate.ts` 的 `canonicalEquals` 对齐：
 * 字符串相等直接通过；否则只对实际值做 `realpath` 归一后比较；
 * `realpath` 失败（路径不存在等）视为不匹配。
 */
async function sameCwd(actual: string | undefined, expected: string): Promise<boolean> {
  if (actual === undefined) return false
  if (actual === expected) return true
  try {
    return (await realpath(actual)) === expected
  } catch {
    return false
  }
}

/** 读取当前默认模型；`resume` 不带 `agentOptions` 会恢复出没有模型的 Agent。 */
function defaultAgentOptions(ctx: Context): AgentOptions {
  const selection = ctx.agentDefaultModel.currentSelection()
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  }
}

/** 创建/恢复得到的 handle 由调用方持有，并随插件 fiber 卸载释放。 */
function releaseOnUnload(ctx: Context, handle: AgentHandle): void {
  ctx.effect(() => () => handle.dispose(), 'example:dispose-agent')
}

/**
 * ensure 的参考实现：保证 `ctx.agentBase.mainSessionId` 有一个 live Agent。
 *
 * 状态机（与方案 §3.4 一致）：
 *   live 命中 → 复用
 *   stat 有快照 → 校验 cwd → `resume`（必须带 agentOptions）
 *   stat 无快照 → `create`（meta.cwd 固定为 workspaceCwd）→ `attachSession`
 */
export function ensureMain(ctx: Context, agentPreset?: string): Promise<Agent> {
  return singleFlight(ctx, ctx.agentBase.mainSessionId, () =>
    createOrResumeMain(ctx, agentPreset),
  )
}

async function createOrResumeMain(ctx: Context, agentPreset?: string): Promise<Agent> {
  const { workspaceCwd, mainSessionId } = ctx.agentBase

  const live = ctx.agents.get(mainSessionId)
  if (live !== undefined) return live

  const preset = await ctx.agentPresets.resolve(agentPreset)
  const agentOptions = defaultAgentOptions(ctx)
  const setup: AgentSetup = async agentCtx => {
    await ctx.agentPresets.mount(agentCtx, preset.id)
  }

  const snapshot = await ctx.sessionPersistence.stat(mainSessionId)
  if (snapshot !== undefined) {
    // base 启动时已校验过一次；消费方在真正恢复前仍要自己再校验，避免运行期被改绑。
    // 比较用 canonical 语义（与 base 一致），历史 session 的 symlink 拼写不会误报。
    if (!(await sameCwd(snapshot.header.cwd, workspaceCwd))) {
      throw new Error(
        `main session '${mainSessionId}' lives in '${snapshot.header.cwd ?? '<none>'}', ` +
          `expected '${workspaceCwd}'`,
      )
    }
    const handle = await ctx.agents.resume({
      resumeSessionId: mainSessionId,
      agentOptions,
      setup,
    })
    releaseOnUnload(ctx, handle)
    return handle.agent
  }

  const handle = await ctx.agents.create({
    sessionId: mainSessionId,
    meta: { cwd: workspaceCwd, agentPreset: preset.id },
    agentOptions,
    setup,
  })
  try {
    // 新建的 session 必须进固定 workspace；`create(workspaceCwd)` 按路径幂等复用。
    const workspace = await ctx.workspaceRegistry.create(workspaceCwd)
    await workspace.attachSession(mainSessionId)
  } catch (error) {
    await handle.dispose()
    throw error
  }
  releaseOnUnload(ctx, handle)
  return handle.agent
}

/**
 * 显式 session 路径：直接使用调用方给的 id，**不读** `ctx.agentBase`。
 *
 * 这类 session 的 cwd / preset 由调用方负责；这里只做 live → resume 的兜底，
 * 不创建（消费方没有固定 workspace 时无权替它决定新 session 落在哪）。
 * 同理也不 mount preset：依赖 preset 组合的调用方自行传 `setup` 给 `resume`。
 */
function ensureExplicit(ctx: Context, sessionId: SessionId): Promise<Agent> {
  return singleFlight(ctx, sessionId, () => resumeExplicit(ctx, sessionId))
}

async function resumeExplicit(ctx: Context, sessionId: SessionId): Promise<Agent> {
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return live

  const snapshot = await ctx.sessionPersistence.stat(sessionId)
  if (snapshot === undefined) {
    throw new Error(
      `explicit session '${sessionId}' is neither live nor persisted; ` +
        'explicit sessions are never created by this helper',
    )
  }

  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: defaultAgentOptions(ctx),
  })
  releaseOnUnload(ctx, handle)
  return handle.agent
}

/**
 * 投递入口：有显式 session 就用显式 session，否则落到 main session。
 *
 * `followup` 只是默认选择；需要插入当前 step 时由消费方改用 `agent.steer(...)`。
 */
export async function deliver(ctx: Context, input: DeliverInput): Promise<void> {
  const agent =
    input.sessionId !== undefined
      ? await ensureExplicit(ctx, input.sessionId)
      : await ensureMain(ctx, input.agentPreset)

  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: input.text }],
      source: {
        kind: 'example-dispatch',
        deliveryId: input.deliveryId,
        form: 'notice',
        summary: '后台派单',
      },
    }),
  )
}
