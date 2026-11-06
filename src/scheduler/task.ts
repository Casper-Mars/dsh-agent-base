/**
 * 完整触发链（技术方案 §5.3）：读任务 → 目标解析 → 分派（text / script）→ 投递
 * → 失败归类与 24h 通知窗口。
 *
 * 与 rsi-agent 的差异（base 没有依赖安装 / disclaimer / trace / runtime 白名单）：
 *   - 不装依赖、不拼 disclaimer、不注入 trace 环境变量；
 *   - 运行时只认 `node`，扩展名不支持直接由 `validate.ts` 判为 `runtime`；
 *   - 投递统一走 {@link DeliveryPort}，冷却由本模块用注入时钟判定。
 *
 * 不变量：
 *   1. **绝不抛异常**：所有失败收敛为 `failed` 结局（含 `notified` /
 *      `consecutiveFailures`），调度链不会因为一次任务异常而中断；
 *   2. **失败统一走 `processFailure`**（归类 + 连续计数 + 24h 窗口），成功走
 *      `processSuccess`（只清计数，**不产生任何消息**）；
 *   3. **目标在执行前解析**：长任务执行期间目标会话可能变化，提前解析避免
 *      「执行完再找目标」造成的漂移；
 *   4. **冷却只在投递成功后生效**：`cooldown_ms` 的语义是「上一条消息投出去后
 *      的静默期」，执行失败 / 跳过不消耗冷却；
 *   5. **单测不起子进程**：执行策略、投递端口、时钟、状态全部注入。
 */
import { dirname } from 'node:path'
import { processFailure, processSuccess } from './failure.js'
import type { FailureStatePort } from './failure.js'
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
  parseTaskOutput,
  truncationDetail,
} from './runner.js'
import type { TaskStatus } from './state.js'
import {
  DEFAULT_MAX_DELIVER_CHARS,
  deriveSummary,
  renderText,
  truncateText,
} from './text.js'
import { resolveScriptPath, validateScript } from './validate.js'
import type {
  Clock,
  DeliveryInput,
  DeliveryPort,
  DeliveryResult,
  DeliveryTarget,
  ExecResult,
  ExecStrategy,
  ScriptTaskDef,
  TaskDef,
  TaskFailureKind,
  TaskRunOutcome,
  TextTaskDef,
} from './types.js'

/** 日志出口：`{info,warn,error}` 对象或单函数（两者都当作同一出口）。 */
export type TaskLogger =
  | {
      info?(message: string, meta?: unknown): void
      warn?(message: string, meta?: unknown): void
      error?(message: string, meta?: unknown): void
    }
  | ((message: string, meta?: unknown) => void)

interface NormalizedLogger {
  readonly info: (message: string, meta?: unknown) => void
  readonly warn: (message: string, meta?: unknown) => void
  readonly error: (message: string, meta?: unknown) => void
}

/** 归一化日志出口；未注入时全部为无操作。 */
function loggerOf(logger: TaskLogger | undefined): NormalizedLogger {
  if (logger === undefined) return { info: () => {}, warn: () => {}, error: () => {} }
  if (typeof logger === 'function') return { info: logger, warn: logger, error: logger }
  return {
    info: (message, meta) => logger.info?.(message, meta),
    warn: (message, meta) => logger.warn?.(message, meta),
    error: (message, meta) => logger.error?.(message, meta),
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 投递端口（在 {@link DeliveryPort} 之上可选提供 `deliverNotice`）。
 *
 * `deliverNotice` 由投递实现负责「自定义目标不可达时改投 main 一次」；
 * 未提供时退化为一次普通 `deliver`（仍是「至少尝试一次」的语义）。
 */
export interface TaskDeliveryPort extends DeliveryPort {
  /** 失败通知专用投递（含改投 main 的回退）。 */
  deliverNotice?(input: DeliveryInput): Promise<DeliveryResult>
}

/** 失败链状态端口（`StateStore` 结构兼容）。 */
export interface TaskStatePort extends FailureStatePort {
  /** 记录一次成功（清空失败链）。 */
  recordSuccess(taskId: string, now?: Date): TaskStatus
  /** 派生状态视图（含 `nextNotifyAt`）。 */
  status(taskId: string): TaskStatus
}

/**
 * 冷却记录（任务 id → 最近一次**投递成功**时刻）。
 *
 * 放在内存里：冷却只约束「本进程的重复投递」，进程重启后重新计时是可接受的
 * （重启后第一次触发本来就该投递）。多实例部署时每个实例各有一份，属于已知
 * 的弱一致取舍，换来的实现不需要额外落盘。
 */
export interface CooldownStore {
  /** 最近一次投递成功时刻；从未投递返回 `undefined`。 */
  get(taskId: string): Date | undefined
  /** 记录一次投递成功。 */
  set(taskId: string, at: Date): void
}

/** 创建内存冷却记录。 */
export function createCooldownStore(): CooldownStore {
  const last = new Map<string, Date>()
  return {
    get(taskId) {
      return last.get(taskId)
    },
    set(taskId, at) {
      last.set(taskId, new Date(at.getTime()))
    },
  }
}

/**
 * 默认冷却记录。
 *
 * 只在调用方**没有**注入 `cooldown` 时使用（直接调用 {@link runTask} 的场景）；
 * `SchedulerService` 会为每个实例注入独立记录，避免多实例互相污染。
 */
const defaultCooldown: CooldownStore = createCooldownStore()

/** {@link runTask} 的依赖面（全部注入，单测零副作用）。 */
export interface RunTaskDeps {
  /** 任务定义来源。 */
  readonly store: { get(id: string): TaskDef | undefined }
  /** 投递端口。 */
  readonly delivery: TaskDeliveryPort
  /** 执行策略（script 任务）。 */
  readonly exec: ExecStrategy
  /** 失败 / 成功状态。 */
  readonly state: TaskStatePort
  /** 时钟（文本占位符、冷却、失败时刻都读它）。 */
  readonly clock: Clock
  /** 日志出口。 */
  readonly logger?: TaskLogger
  /** 任务时区（cron 与正文占位符共用）。 */
  readonly timezone: string
  /** 固定 workspace（解析相对 `task_path`）。 */
  readonly workspace: string
  /** 正文预算（字素），缺省 {@link DEFAULT_MAX_DELIVER_CHARS}。 */
  readonly maxDeliverChars?: number
  /** 是否允许执行脚本任务；`false` 时 script 任务直接 `failed / runtime`。 */
  readonly allowScript?: boolean
  /** 任务定义目录（**相对 workspace**，失败通知里展示），缺省 `.agent-base/tasks`。 */
  readonly tasksDir?: string
  /** 冷却记录；缺省用模块级默认记录。 */
  readonly cooldown?: CooldownStore
  /** 执行超时（毫秒），缺省 {@link DEFAULT_TASK_TIMEOUT_MS}。 */
  readonly timeoutMs?: number
  /** stdout 上限（字节），缺省 {@link DEFAULT_MAX_STDOUT_BYTES}。 */
  readonly maxStdoutBytes?: number
  /** stderr 上限（字节），缺省 {@link DEFAULT_MAX_STDERR_BYTES}。 */
  readonly maxStderrBytes?: number
  /** 触发期文件校验（测试注入），缺省 {@link validateScript}。 */
  readonly validate?: (
    workspace: string,
    taskPath: string,
  ) => Promise<{ readonly path: string }>
}

/** 任务类型（`kind` 缺省即 script）。 */
function isTextTask(task: TaskDef): task is TextTaskDef {
  return task.kind === 'text'
}

/**
 * 「任务定义缺失」时用于生成失败通知的占位定义。
 *
 * 任务文件在 `list()` 与触发之间被删除时，仍然要按 D12 走通知窗口；通知需要
 * 一个 TaskDef 来渲染标题与定义路径，这里用 `kind: 'text'` 占位（不会伪造
 * 任务程序路径）。
 */
function missingTaskStub(taskId: string): TaskDef {
  return {
    id: taskId,
    name: taskId,
    cron: '0 0 * * *',
    enabled: false,
    kind: 'text',
    text: '',
  }
}

/** 失败结局构造参数。 */
interface FailOptions {
  readonly kind: TaskFailureKind
  readonly reason: string
  readonly detail?: string
  /** 已解析的投递目标（失败通知复用它，避免二次解析 / 目标漂移）。 */
  readonly target?: DeliveryTarget
  /** 任务程序绝对路径（仅 script，通知里展示）。 */
  readonly scriptPath?: string
}

/**
 * 失败通知投递器：解析目标 → `deliverNotice`（无则 `deliver`）→ 布尔结果。
 *
 * 「投递失败时改投 main 一次」由投递实现的 `deliverNotice` 承担（base 的
 * `createDeliveryPort` 已实现该回退）；这里**绝不抛异常**，投递失败只返回
 * `false`，由 `processFailure` 记录「未通知」且不消耗 24h 窗口。
 */
function createNoticeDeliverer(
  deps: RunTaskDeps,
  log: NormalizedLogger,
  task: TaskDef,
  resolved?: DeliveryTarget,
): (text: string) => Promise<boolean> {
  return async (text: string): Promise<boolean> => {
    let target = resolved
    if (target === undefined) {
      try {
        target = await deps.delivery.resolveTarget(task)
      } catch (error) {
        log.warn(`任务 ${task.id} 失败通知目标解析失败：${describeError(error)}`)
        return false
      }
    }
    const input: DeliveryInput = {
      taskId: task.id,
      text,
      summary: deriveSummary(text),
      sessionId: target.sessionId,
      ...(target.fallbackFrom === undefined ? {} : { fallbackFrom: target.fallbackFrom }),
    }
    try {
      const result =
        deps.delivery.deliverNotice === undefined
          ? await deps.delivery.deliver(input)
          : await deps.delivery.deliverNotice(input)
      // `queued` 表示消息已被 outbox 接收（会在目标上线后补投），视作已通知，
      // 否则每次失败都会再排一条同样的通知。
      if (result === 'delivered' || result === 'queued') return true
      log.warn(
        `任务 ${task.id} 失败通知未能投递（${result}），24h 窗口未消耗`,
        { taskId: task.id, sessionId: target.sessionId },
      )
      return false
    } catch (error) {
      log.warn(`任务 ${task.id} 失败通知投递异常：${describeError(error)}`)
      return false
    }
  }
}

/**
 * 统一失败出口：记账（processFailure）→ 组装 `failed` 结局。
 *
 * 这里**只调用一次** `processFailure`，24h 窗口 / 连续计数 / 通知文案全部由它
 * 负责；本函数只把结果映射到 {@link TaskRunOutcome}。
 */
async function fail(
  task: TaskDef,
  deps: RunTaskDeps,
  log: NormalizedLogger,
  options: FailOptions,
): Promise<TaskRunOutcome> {
  const detail = options.detail?.trim()
  log.error(
    `任务 ${task.id} 失败（${options.kind}）：${options.reason}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`,
    { taskId: task.id, failureKind: options.kind },
  )

  let notified = false
  let consecutiveFailures = 0
  try {
    const result = await processFailure(
      task,
      {
        kind: options.kind,
        ...(detail === undefined || detail === '' ? {} : { detail }),
      },
      {
        state: deps.state,
        now: deps.clock.now(),
        deliverNotice: createNoticeDeliverer(deps, log, task, options.target),
        timezone: deps.timezone,
        ...(deps.tasksDir === undefined ? {} : { tasksDir: deps.tasksDir }),
        ...(options.scriptPath === undefined ? {} : { scriptPath: options.scriptPath }),
        // 刻意不把 logger 透传给 processFailure：失败日志由本层**每次失败一条**
        // 统一输出，避免「一次失败多行日志」破坏「失败 N 次 = N 条日志」的口径。
        // 通知投递异常由 createNoticeDeliverer 自己 warn，不会丢诊断信息。
      },
    )
    notified = result.notified
    consecutiveFailures = result.status.consecutiveFailures
  } catch (error) {
    // processFailure 契约上不抛；这里兜底一次，失败结局仍要返回。
    log.warn(`任务 ${task.id} 失败记账异常（已忽略）：${describeError(error)}`)
  }

  return {
    kind: 'failed',
    reason: options.reason,
    ...(detail === undefined || detail === '' ? {} : { detail }),
    failureKind: options.kind,
    notified,
    consecutiveFailures,
  }
}

/** 成功记账（静默，不投递任何消息）。 */
function succeed(task: TaskDef, deps: RunTaskDeps, now: Date): void {
  processSuccess(task.id, { state: deps.state, now })
}

/** 冷却是否生效（`elapsed < cooldownMs` 即仍在窗口内；时钟回拨按冷却处理）。 */
function cooldownSkip(
  task: TaskDef,
  deps: RunTaskDeps,
  now: Date,
): TaskRunOutcome | undefined {
  const cooldownMs = task.cooldown_ms ?? 0
  if (cooldownMs <= 0) return undefined
  const last = (deps.cooldown ?? defaultCooldown).get(task.id)
  if (last === undefined) return undefined
  const elapsed = now.getTime() - last.getTime()
  if (elapsed >= cooldownMs) return undefined
  return {
    kind: 'skipped',
    reason: `任务 ${task.id} 处于投递冷却中（cooldown_ms=${cooldownMs}），本次触发跳过`,
    detail: `距上次投递 ${Math.max(elapsed, 0)}ms，剩余 ${cooldownMs - Math.max(elapsed, 0)}ms`,
  }
}

/** 投递一条结果消息并映射结局（成功记账 / 冷却 / 失败归类都在这里收口）。 */
async function deliverText(
  task: TaskDef,
  deps: RunTaskDeps,
  log: NormalizedLogger,
  target: DeliveryTarget,
  text: string,
): Promise<TaskRunOutcome> {
  const input: DeliveryInput = {
    taskId: task.id,
    text,
    summary: deriveSummary(text),
    sessionId: target.sessionId,
    ...(target.fallbackFrom === undefined ? {} : { fallbackFrom: target.fallbackFrom }),
  }

  let result: DeliveryResult
  try {
    result = await deps.delivery.deliver(input)
  } catch (error) {
    return fail(task, deps, log, {
      kind: 'deliver',
      reason: `任务 ${task.id} 投递失败`,
      detail: describeError(error),
      target,
    })
  }

  if (result === 'failed') {
    return fail(task, deps, log, {
      kind: 'deliver',
      reason: `任务 ${task.id} 投递失败`,
      detail: 'main session 未 provisioned',
      target,
    })
  }

  if (result === 'skipped') {
    log.warn(
      `任务 ${task.id} 投递被跳过（目标 ${target.sessionId}）`,
      { taskId: task.id, sessionId: target.sessionId },
    )
    return {
      kind: 'skipped',
      reason: `任务 ${task.id} 投递被跳过`,
      detail: '投递端口返回 skipped',
    }
  }

  // 投递成功（delivered / queued）：清失败链、开始冷却（记**完成时刻**，
  // 长任务不能把成功时刻记成触发时刻）。
  const successAt = deps.clock.now()
  succeed(task, deps, successAt)
  ;(deps.cooldown ?? defaultCooldown).set(task.id, successAt)

  const common = {
    reason:
      result === 'delivered'
        ? `任务 ${task.id} 已投递到 ${target.sessionId}`
        : `任务 ${task.id} 目标 ${target.sessionId} 未 live，消息已入队`,
    targets: [target.sessionId],
    ...(target.fallbackFrom === undefined ? {} : { fallbackFrom: target.fallbackFrom }),
  }
  return result === 'delivered'
    ? { kind: 'woke', data: text, ...common }
    : { kind: 'queued', ...common }
}

/** 脚本执行结果 → 失败结局（`undefined` 表示成功，继续解析 stdout）。 */
function execFailure(
  task: TaskDef,
  result: ExecResult,
  timeoutMs: number,
  maxStdoutBytes: number,
): FailOptions | undefined {
  const stderr = result.stderr.trim()
  const detailOfStderr = stderr === '' ? undefined : stderr

  if (result.spawnError !== undefined) {
    return {
      kind: 'runtime',
      reason: `任务 ${task.id} 进程启动失败（运行时不可用）`,
      detail: result.spawnError,
    }
  }
  if (result.timedOut) {
    return {
      kind: 'exec',
      reason: `任务 ${task.id} 执行超时（${timeoutMs}ms），已强杀`,
      ...(detailOfStderr === undefined ? {} : { detail: detailOfStderr }),
    }
  }
  if (result.truncated) {
    return {
      kind: 'exec',
      reason: `任务 ${task.id} ${truncationDetail(maxStdoutBytes)}`,
      ...(detailOfStderr === undefined ? {} : { detail: detailOfStderr }),
    }
  }
  if (result.exitCode !== 0) {
    return {
      kind: 'exec',
      reason: `任务 ${task.id} 进程异常退出（exitCode=${String(result.exitCode)}）`,
      ...(detailOfStderr === undefined ? {} : { detail: detailOfStderr }),
    }
  }
  return undefined
}

/** 文本任务分支：渲染 → 空文本静默 → 投递。 */
async function runTextTask(
  task: TextTaskDef,
  deps: RunTaskDeps,
  log: NormalizedLogger,
  target: DeliveryTarget,
  now: Date,
): Promise<TaskRunOutcome> {
  const text = renderText(task.text, {
    taskId: task.id,
    timezone: deps.timezone,
    now,
    maxChars: deps.maxDeliverChars ?? DEFAULT_MAX_DELIVER_CHARS,
  })

  if (text.trim() === '') {
    // 空正文视为「无需通知」：仍算一次成功执行（清失败链、写 lastSuccessAt）。
    succeed(task, deps, deps.clock.now())
    return { kind: 'quiet', reason: `任务 ${task.id} 正文为空，未投递` }
  }

  return deliverText(task, deps, log, target, text)
}

/** 脚本任务分支：禁脚本 → 文件校验 → 执行 → 末行 JSON → 投递。 */
async function runScriptTask(
  task: ScriptTaskDef,
  deps: RunTaskDeps,
  log: NormalizedLogger,
  target: DeliveryTarget,
): Promise<TaskRunOutcome> {
  if (deps.allowScript === false) {
    return fail(task, deps, log, {
      kind: 'runtime',
      reason: `任务 ${task.id} 是脚本任务，但当前配置禁止执行脚本（allowScript=false）`,
      target,
    })
  }

  // 触发期兜底校验：路径形态（扩展名 / 控制字符）+ 存在性 + 普通文件 + 可读性。
  const resolvedPath = resolveScriptPath(deps.workspace, task.task_path)
  const validate = deps.validate ?? validateScript
  let scriptPath: string
  try {
    const result = await validate(deps.workspace, task.task_path)
    scriptPath = result.path
  } catch (error) {
    const failureKind =
      (error as { failureKind?: TaskFailureKind }).failureKind ?? 'missing'
    return fail(task, deps, log, {
      kind: failureKind,
      reason: `任务 ${task.id} 任务程序不可用`,
      detail: describeError(error),
      target,
      scriptPath: resolvedPath,
    })
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
  const maxStdoutBytes = deps.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
  const maxStderrBytes = deps.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES

  let execResult: ExecResult
  try {
    execResult = await deps.exec.exec({
      scriptPath,
      cwd: dirname(scriptPath),
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
    })
  } catch (error) {
    // ExecStrategy 契约上不抛；异常实现按「执行失败」兜底。
    return fail(task, deps, log, {
      kind: 'exec',
      reason: `任务 ${task.id} 执行异常`,
      detail: describeError(error),
      target,
      scriptPath,
    })
  }

  const execFail = execFailure(task, execResult, timeoutMs, maxStdoutBytes)
  if (execFail !== undefined) {
    return fail(task, deps, log, { ...execFail, target, scriptPath })
  }

  const parsed = parseTaskOutput(execResult.stdout)
  if (parsed === null) {
    return fail(task, deps, log, {
      kind: 'parse',
      reason: `任务 ${task.id} 输出不可解析（stdout 最后非空行无有效结果 JSON）`,
      detail: '期望 {"shouldWake":boolean,"data"?:string}',
      target,
      scriptPath,
    })
  }

  if (!parsed.shouldWake) {
    succeed(task, deps, deps.clock.now())
    return { kind: 'quiet', reason: `任务 ${task.id} 执行完成，未唤醒` }
  }

  const text = truncateText(parsed.data, deps.maxDeliverChars ?? DEFAULT_MAX_DELIVER_CHARS)
  return deliverText(task, deps, log, target, text)
}

/**
 * 执行一次任务（**不抛异常**），返回六态结局之一。
 *
 * 顺序固定：
 *   1. `store.get(taskId)`（未命中 → `failed / missing`，仍走通知窗口）；
 *   2. 冷却判断（投递成功后的静默期内 → `skipped`）；
 *   3. `resolveTarget(task)`（**执行前**解析，避免目标漂移）；
 *   4. 按 `kind` 分派到文本 / 脚本分支。
 *
 * @param taskId 任务 id（必须与任务文件名骨架一致）。
 * @param deps   全部注入的依赖（存储 / 投递 / 执行 / 状态 / 时钟 / 日志）。
 */
export async function runTask(
  taskId: string,
  deps: RunTaskDeps,
): Promise<TaskRunOutcome> {
  const log = loggerOf(deps.logger)

  let task: TaskDef | undefined
  try {
    task = deps.store.get(taskId)
  } catch (error) {
    // id 非法等编程错误：状态存储同样无法按 id 记账，只能如实返回未处理失败。
    log.warn(`任务 ${taskId} 任务定义读取失败：${describeError(error)}`)
    return {
      kind: 'failed',
      reason: `任务 ${taskId} 任务定义读取失败`,
      detail: describeError(error),
      failureKind: 'missing',
      notified: false,
      consecutiveFailures: 0,
    }
  }

  if (task === undefined) {
    const stub = missingTaskStub(taskId)
    return fail(stub, deps, log, {
      kind: 'missing',
      reason: `任务 ${taskId} 不存在（任务定义缺失）`,
    })
  }

  const now = deps.clock.now()

  const cooling = cooldownSkip(task, deps, now)
  if (cooling !== undefined) return cooling

  let target: DeliveryTarget
  try {
    target = await deps.delivery.resolveTarget(task)
  } catch (error) {
    return fail(task, deps, log, {
      kind: 'deliver',
      reason: `任务 ${task.id} 投递目标解析失败`,
      detail: describeError(error),
    })
  }
  if (target.reason !== undefined && target.reason !== '') {
    log.info(`任务 ${task.id} 目标解析：${target.reason}`, {
      taskId: task.id,
      sessionId: target.sessionId,
      ...(target.fallbackFrom === undefined ? {} : { fallbackFrom: target.fallbackFrom }),
    })
  }

  if (isTextTask(task)) {
    return runTextTask(task, deps, log, target, now)
  }
  return runScriptTask(task, deps, log, target)
}
