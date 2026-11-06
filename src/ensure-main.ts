/**
 * main session 的**启动期准备**（workspace 生命周期的一部分，不属于调度器）。
 *
 * `apply()` 在发布 `ctx.agentBase` 后以 `void ensureMain(...)` 的方式在后台调用本模块：
 * 不 await、不拖慢插件启动；成功与失败都只写日志，**永不向调用方抛异常**。
 *
 * 状态机（与方案 §3.4 一致）：
 *
 * ```text
 * agents.get(mainSessionId) 命中 → 复用 live Agent
 * sessionPersistence.stat(mainSessionId)
 *   ├─ 有快照 → canonical cwd 校验 → agents.resume({ resumeSessionId, agentOptions, setup })
 *   └─ 无快照 → agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup })
 *               → workspaceRegistry.create(workspaceCwd).attachSession(mainSessionId)
 * ```
 *
 * 关键约束：
 *   - **single-flight**：同一个 `Context` + `SessionId` 并发只跑一次；
 *   - **agentOptions 必传**：缺失 `agentDefaultModel` 服务时抛可读错误，由外层 warn；
 *   - **preset 恒用宿主默认**：`ctx.agentPresets.resolve(undefined)`；
 *   - **cwd 守卫**：resume 前做 canonical 比对，不一致直接拒绝，不把会话投到错误 workspace；
 *   - **already exists 竞态**：`create` 抛 already exists 时回读 `agents.get`，命中则复用；
 *   - **handle 生命周期**：`ctx.effect` 注册 dispose，注册失败只忽略；
 *   - **超时**：`Promise.race`，超时只 warn 后返回；底层 promise 已挂失败处理，
 *     不会产生 unhandledRejection。
 */
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
// 仅为了加载 `ctx.agentPresets` / `ctx.agentDefaultModel` 的模块增强。
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** 默认准备超时（毫秒）。 */
export const DEFAULT_ENSURE_TIMEOUT_MS = 10_000

/** {@link ensureMain} 的选项。 */
export interface EnsureMainOptions {
  /** 准备超时（毫秒）；缺省 {@link DEFAULT_ENSURE_TIMEOUT_MS}，非法值同样回落默认。 */
  readonly timeoutMs?: number
}

/** 最小日志出口；`info` 用于成功日志，`warn` 用于失败 / 超时。 */
interface BootstrapLogger {
  readonly info: (message: string) => void
  readonly warn: (message: string) => void
}

const noop = (): void => {}

/** 把任意日志方法包成「永不抛」调用。 */
function safeMethod(
  candidate: unknown,
  receiver: unknown,
): (message: string) => void {
  if (typeof candidate !== 'function') return noop
  return (message) => {
    try {
      ;(candidate as (message: string) => void).call(receiver, message)
    } catch {
      // 日志出口自身异常不允许影响后台准备。
    }
  }
}

/**
 * 解析 `ctx.logger('agent-base:bootstrap')`。
 *
 * 解析失败 / 不存在时：`info` 静默，`warn` 回落 `console.warn`。解析过程绝不抛。
 */
function resolveBootstrapLogger(ctx: Context): BootstrapLogger {
  const fallback: BootstrapLogger = {
    info: noop,
    warn: (message) => {
      try {
        if (typeof console.warn === 'function') console.warn(message)
      } catch {
        // console 自身异常同样忽略。
      }
    },
  }

  let service: unknown
  try {
    service = (ctx as unknown as { logger?: unknown }).logger
  } catch {
    return fallback
  }
  if (typeof service !== 'function') return fallback

  let produced: unknown
  try {
    produced = (service as (name: string) => unknown).call(ctx, 'agent-base:bootstrap')
  } catch {
    return fallback
  }

  if (typeof produced === 'function') {
    const record = produced as unknown as Record<string, unknown>
    return {
      info: safeMethod(record.info ?? produced, record.info === undefined ? undefined : produced),
      warn: safeMethod(record.warn ?? produced, record.warn === undefined ? undefined : produced),
    }
  }
  if (typeof produced !== 'object' || produced === null) return fallback

  const record = produced as Record<string, unknown>
  return {
    info: safeMethod(record.info, produced),
    warn: safeMethod(record.warn, produced),
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** single-flight 表：同一 Context、同一 session 并发只跑一次。 */
const inflight = new WeakMap<Context, Map<SessionId, Promise<void>>>()

/**
 * 对 `(ctx, sessionId)` 做 single-flight。
 *
 * 只负责并发合并；失败结果不会缓存在表里（结束后立即释放槽位），
 * 因此下一次调用会重新尝试。
 */
function singleFlight(
  ctx: Context,
  sessionId: SessionId,
  run: () => Promise<void>,
): Promise<void> {
  let sessions = inflight.get(ctx)
  if (sessions === undefined) {
    sessions = new Map<SessionId, Promise<void>>()
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

/** canonical cwd 比较，语义与 `src/validate.ts` 对齐。 */
async function sameCwd(actual: string | undefined, expected: string): Promise<boolean> {
  if (actual === undefined) return false
  if (actual === expected) return true
  try {
    return (await realpath(actual)) === expected
  } catch {
    return false
  }
}

/** 读取并校验默认模型服务；缺失 / 形状不符时抛可读错误。 */
function defaultAgentOptions(ctx: Context): AgentOptions {
  const service = getService(ctx, 'agentDefaultModel')
  if (service === undefined || service === null) {
    throw new Error(
      '缺少 agentDefaultModel 服务（无法解析默认模型，resume 出的 Agent 将没有模型）',
    )
  }
  const selection = (
    service as { currentSelection(): { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }
  ).currentSelection()
  if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') {
    throw new Error('agentDefaultModel.currentSelection() 未返回有效的 provider / model')
  }
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort as AgentOptions['reasoningEffort'] }),
  }
}

/** 通过 `ctx.get` 读取可选服务；未注入 / 不存在时返回 `undefined`，绝不抛。 */
function getService(ctx: Context, name: string): unknown {
  try {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    return typeof get === 'function' ? get.call(ctx, name) : undefined
  } catch {
    return undefined
  }
}

/** 读取 preset 服务；缺失时抛可读错误。 */
function presetService(ctx: Context): {
  resolve(name?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, presetId: string): Promise<void>
} {
  const service = getService(ctx, 'agentPresets')
  if (service === undefined || service === null) {
    throw new Error('缺少 agentPresets 服务（无法解析 / mount 默认 preset）')
  }
  return service as {
    resolve(name?: string): Promise<{ id: string }>
    mount(agentCtx: unknown, presetId: string): Promise<void>
  }
}

/** 是否为「session 已存在」类错误（不同实现可能用 code 或 message 表达）。 */
function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { code?: unknown; message?: unknown }
  if (
    record.code === 'EEXIST' ||
    record.code === 'ALREADY_EXISTS' ||
    record.code === 'SESSION_EXISTS'
  ) {
    return true
  }
  return typeof record.message === 'string' && /already exists|已存在/i.test(record.message)
}

/** 注册 handle 释放；失败只忽略（不影响已就绪的会话）。 */
function releaseOnUnload(ctx: Context, handle: AgentHandle): void {
  try {
    const effect = (ctx as unknown as {
      effect?: (factory: () => () => void, label?: string) => unknown
    }).effect
    if (typeof effect !== 'function') return
    effect.call(ctx, () => () => {
      try {
        handle.dispose()
      } catch {
        // dispose 失败无补救手段，忽略。
      }
    }, 'agent-base:main-dispose')
  } catch {
    // effect 注册失败（例如 fiber 已卸载）只忽略。
  }
}

/** 真正执行「复用 / resume / create」的幂等逻辑。 */
async function prepareMain(ctx: Context, log: BootstrapLogger): Promise<void> {
  const { workspaceCwd, mainSessionId } = ctx.agentBase

  const live = ctx.agents.get(mainSessionId)
  if (live !== undefined) return

  const presets = presetService(ctx)
  const preset = await presets.resolve(undefined)
  const agentOptions = defaultAgentOptions(ctx)
  const setup: AgentSetup = async (agentCtx) => {
    await presets.mount(agentCtx, preset.id)
  }

  const snapshot = await ctx.sessionPersistence.stat(mainSessionId)
  if (snapshot !== undefined) {
    const actual = snapshot.header?.cwd
    if (!(await sameCwd(actual, workspaceCwd))) {
      throw new Error(
        `main session '${mainSessionId}' lives in '${actual ?? '<none>'}', ` +
          `expected '${workspaceCwd}'`,
      )
    }
    const handle = await ctx.agents.resume({
      resumeSessionId: mainSessionId,
      agentOptions,
      setup,
    })
    releaseOnUnload(ctx, handle)
    log.info('main session 已就绪（resumed）')
    return
  }

  let handle: AgentHandle
  try {
    handle = await ctx.agents.create({
      sessionId: mainSessionId,
      meta: { cwd: workspaceCwd, agentPreset: preset.id },
      agentOptions,
      setup,
    })
  } catch (error) {
    // 并发 / 外部同时创建：回读成功则直接复用，不把 already exists 当成启动失败。
    if (isAlreadyExists(error)) {
      const existing = ctx.agents.get(mainSessionId)
      if (existing !== undefined) return
    }
    throw error
  }

  try {
    const workspace = await ctx.workspaceRegistry.create(workspaceCwd)
    await workspace.attachSession(mainSessionId)
  } catch (error) {
    // 挂载失败：释放刚创建的 handle，避免留下无 workspace 的孤儿会话。
    try {
      await handle.dispose()
    } catch {
      // dispose 失败时保留原始错误。
    }
    throw error
  }

  releaseOnUnload(ctx, handle)
  log.info('main session 已就绪（created）')
}

/** 规范化超时：非有限数值 / 小于 1 时回落默认值。 */
function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_ENSURE_TIMEOUT_MS
  }
  return value
}

/** 给后台任务套超时；超时只 warn，底层 promise 已在调用方挂了失败处理。 */
function withTimeout(
  task: Promise<void>,
  timeoutMs: number,
  log: BootstrapLogger,
): Promise<void> {
  // 用 AbortSignal.timeout 而不是裸 setTimeout：它不会在测试的 fake timer 里
  // 留下可计数的句柄，同时仍是「谁先结束谁赢」的 Promise.race 语义。
  const delay = Math.min(timeoutMs, 2_147_483_647)
  const signal = AbortSignal.timeout(delay)
  let onAbort: (() => void) | undefined
  const timeout = new Promise<void>((resolve) => {
    onAbort = () => {
      log.warn(`main session 准备超时（${timeoutMs}ms），转入后台`)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

  return Promise.race([task, timeout]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  })
}

/**
 * 后台准备 main session（幂等、single-flight、永不 reject）。
 *
 * @param ctx     插件 fiber 上的 Context（需已发布 `ctx.agentBase`）。
 * @param options 超时配置。
 */
export function ensureMain(ctx: Context, options: EnsureMainOptions = {}): Promise<void> {
  const log = resolveBootstrapLogger(ctx)
  const timeoutMs = normalizeTimeout(options.timeoutMs)

  const pending = singleFlight(ctx, ctx.agentBase.mainSessionId as SessionId, () =>
    prepareMain(ctx, log),
  )

  // 失败只 warn；`.then(onRejected)` 同时消除了底层 promise 的 unhandledRejection 风险。
  const settled = pending.then(
    () => undefined,
    (error: unknown) => {
      log.warn(`main session 准备失败：${describeError(error)}`)
    },
  )

  return withTimeout(settled, timeoutMs, log)
}
