/**
 * 调度层公共契约（**契约先行**）。
 *
 * 本文件只有类型定义与类型级约束，**没有任何运行时代码或副作用**：
 *   - 上层（store / runner / deliver / service / tools）只依赖这里的接口，
 *     不直接依赖具体实现；
 *   - 依赖（执行 / 投递 / 时钟 / 定时器）全部可注入，单测绝不真跑子进程、
 *     不真实 sleep、不触碰用户目录；
 *   - 任务模型对「任务程序内容」一无所知：script 只给出路径，text 只给出正文；
 *     占位符展开、截断与消息构造属于后续模块。
 *
 * 契约随技术方案 §4.1 / §4.3 / §4.4 / §5.6 演进；改动本文件视为对调度层
 * 所有实现的接口变更，需要同步评审。
 */

/** 任务类型：脚本任务 / 文本任务。 */
export type TaskKind = 'script' | 'text'

/** 任务定义公共字段（`<tasksDir>/<id>.json`）。 */
interface TaskDefCommon {
  /** 唯一标识（单段文件名，必须通过安全路径段校验）。 */
  readonly id: string
  /** 人类可读名称。 */
  readonly name: string
  /** 严格 5 段 cron（分 时 日 月 周），最小粒度分钟。 */
  readonly cron: string
  /** 是否启用；`false` 的任务不参与调度。 */
  readonly enabled: boolean
  /** 自定义投递目标；缺省投 `mainSessionId`。 */
  readonly session_id?: string
  /** 投递冷却（毫秒，0–3600000）；缺省 0，即不做冷却。 */
  readonly cooldown_ms?: number
}

/**
 * 脚本任务定义：运行任务程序，读取 stdout 末行 JSON。
 *
 * `kind` 可省略，缺省即 `'script'`——这样 rsi-agent 既有的任务定义文件可以
 * 原样拷入。`text` 被声明为 `never`，从类型上禁止与 `task_path` 混用。
 */
export interface ScriptTaskDef extends TaskDefCommon {
  readonly kind?: 'script'
  /** 任务程序入口（相对 workspace 的路径，或绝对路径）；不限目录。 */
  readonly task_path: string
  readonly text?: never
}

/**
 * 文本任务定义：到点把 `text`（展开占位符后）投递给目标会话。
 *
 * `task_path` 被声明为 `never`，从类型上禁止与 `text` 混用。
 */
export interface TextTaskDef extends TaskDefCommon {
  readonly kind: 'text'
  /** 投递正文（含占位符，≤ `maxDeliverChars`）。 */
  readonly text: string
  readonly task_path?: never
}

/** 一条定时任务的定义（`kind` 判别联合，缺省 script）。 */
export type TaskDef = ScriptTaskDef | TextTaskDef

/**
 * 脚本任务的返回值契约：stdout **最后一个非空行**的一行 JSON。
 *
 *   - `{ "shouldWake": true, "data": "..." }` —— 需要投递，`data` 逐字作为正文；
 *   - `{ "shouldWake": false }` —— 静默完成。
 *
 * `shouldWake` 非 boolean、`data` 非 string、末行不是 JSON ⇒ `failed / parse`。
 */
export type TaskScriptResult =
  | { readonly shouldWake: true; readonly data: string }
  | { readonly shouldWake: false }

/**
 * 失败分类（与结局 `failed` 搭配）。
 *
 * 与 rsi-agent 的 install / spawn / wake 不同：base 不装依赖、不区分 spawn，
 * 统一按「程序缺失 / 运行时不可用 / 执行异常 / 结果解析 / 投递」归类。
 */
export type TaskFailureKind =
  /** 程序不存在 / 不是普通文件 / 不可读。 */
  | 'missing'
  /** 扩展名不在白名单 / 运行时不可用。 */
  | 'runtime'
  /** 非零退出、崩溃、超时、输出超限。 */
  | 'exec'
  /** stdout 末行不是合法结果 JSON。 */
  | 'parse'
  /** 结果 / 失败通知投递失败（非离线可恢复错误）。 */
  | 'deliver'

/**
 * 单次任务运行的结局（六态）。
 *
 * 区分 `woke` / `queued`：前者是目标 live、消息已投递；后者是目标未 live、
 * 消息进入内存 outbox（有限补投）。`missed` 仅表示 outbox 过期丢弃，只写日志。
 */
export type TaskRunOutcome =
  | {
      /** 执行完成，无投递（`shouldWake:false` / 文本为空等）。 */
      readonly kind: 'quiet'
      /** 结局说明。 */
      readonly reason: string
    }
  | {
      /** 已投递成功。 */
      readonly kind: 'woke'
      /** 结局说明。 */
      readonly reason: string
      /** 投递正文（已展开 / 已截断）。 */
      readonly data: string
      /** 实际投递目标（通常只有 mainSessionId 或任务级 session_id）。 */
      readonly targets: readonly string[]
      /** 自定义 session 不可达时，记录被回退的原目标。 */
      readonly fallbackFrom?: string
    }
  | {
      /** 目标非 live，已进入 outbox。 */
      readonly kind: 'queued'
      /** 结局说明。 */
      readonly reason: string
      /** 队列目标会话。 */
      readonly targets: readonly string[]
      /** 自定义 session 不可达时，记录被回退的原目标。 */
      readonly fallbackFrom?: string
    }
  | {
      /** 跳过：冷却中 / 单飞占用 / outbox 超限等。 */
      readonly kind: 'skipped'
      /** 跳过说明。 */
      readonly reason: string
      /** 补充细节。 */
      readonly detail?: string
    }
  | {
      /** 失败：missing / runtime / exec / parse / deliver。 */
      readonly kind: 'failed'
      /** 失败说明。 */
      readonly reason: string
      /** 补充细节。 */
      readonly detail?: string
      /** 失败分类。 */
      readonly failureKind: TaskFailureKind
      /** 本次失败是否已投递失败通知（受每任务 24h 窗口约束）。 */
      readonly notified: boolean
      /** 该任务连续失败次数（含本次）。 */
      readonly consecutiveFailures: number
    }
  | {
      /** 离线队列中的消息过期被丢弃（只写日志，不再补发）。 */
      readonly kind: 'missed'
      /** 丢弃说明。 */
      readonly reason: string
      /** 补充细节。 */
      readonly detail?: string
      /**
       * 消息原定投递时刻（**必填**）。
       *
       * `missed` 表示离线队列条目已过期，该条目必然有过原定投递时刻；缺省会让
       * 类型层与 `task_run_now` 的 output schema（missed 分支 required 含
       * `scheduledAt`）口径分裂，构造出的结局会在输出校验期被判
       * `must match exactly one oneOf branch (matched 0)`。故这里强制必填。
       */
      readonly scheduledAt: Date
    }

/** 时钟源（可注入，便于冷却与通知窗口的边界测试）。 */
export interface Clock {
  /** 当前时刻。 */
  now(): Date
}

/** 定时器句柄。 */
export type TimerHandle = ReturnType<typeof setTimeout>

/** 定时器抽象（可注入，单测用 fake timer，不真实 sleep）。 */
export interface Timer {
  /** 安排一次性定时。 */
  setTimer(delayMs: number, cb: () => void): TimerHandle
  /** 取消已排定的定时。 */
  clearTimer(handle: TimerHandle): void
}

/** 进程执行结果。 */
export interface ExecResult {
  /** 退出码；`null` = 未退出 / 崩溃。 */
  readonly exitCode: number | null
  /** stdout（已按上限截断）。 */
  readonly stdout: string
  /** stderr（有界收集）。 */
  readonly stderr: string
  /** stdout 是否超限被截断。 */
  readonly truncated: boolean
  /** 是否因超时被强杀。 */
  readonly timedOut: boolean
  /** spawn 失败原因（存在时其余字段无意义）。 */
  readonly spawnError?: string
}

/** 执行策略输入。 */
export interface ExecInput {
  /** 任务程序绝对路径。 */
  readonly scriptPath: string
  /** 子进程工作目录（任务程序所在目录，Node 从这里向上解析 `node_modules`）。 */
  readonly cwd: string
  /** 超时上限（毫秒）。 */
  readonly timeoutMs: number
  /** stdout 上限（**UTF-8 字节**；截断点不切开多字节字符）。 */
  readonly maxStdoutBytes: number
  /** stderr 上限（字节）。 */
  readonly maxStderrBytes: number
}

/**
 * 执行策略（v1：`node`）。
 *
 * 实现方负责「起独立进程 → 有界收集输出 → 超时强杀」，并保证**不抛异常**：
 * 失败通过 {@link ExecResult} 字段表达（唯一例外是组合器层面的编程错误）。
 */
export interface ExecStrategy {
  /** 策略名（诊断用，例如 `node`）。 */
  readonly name: string
  /** 执行任务程序。 */
  exec(input: ExecInput): Promise<ExecResult>
}

/** 投递目标解析结果。 */
export interface DeliveryTarget {
  /** 实际投递的 session id（自定义目标不可达时为回退后的 main）。 */
  readonly sessionId: string
  /** 发生回退时，原自定义目标 session id。 */
  readonly fallbackFrom?: string
  /** 回退 / 降级原因（写日志用）。 */
  readonly reason?: string
}

/** 投递输入。 */
export interface DeliveryInput {
  /** 任务 id（冷却键 / 日志字段）。 */
  readonly taskId: string
  /** 投递正文（已展开占位符、已按预算截断）。 */
  readonly text: string
  /** 一行摘要（notice 形态需要）。 */
  readonly summary: string
  /** 投递目标会话 id。 */
  readonly sessionId: string
  /** 发生回退时的原目标（透传给消息元数据 / 日志）。 */
  readonly fallbackFrom?: string
}

/** 投递结果：已投递 / 已入离线队列 / 已跳过 / 目标从未 provisioned。 */
export type DeliveryResult = 'delivered' | 'queued' | 'skipped' | 'failed'

/**
 * 投递端口（由宿主注入）。
 *
 * - `resolveTarget` 解析实际目标：自定义 session 不可达时记 error 并回退 main；
 * - `deliver` 只负责「把这条消息送出去或入队」，不负责任务状态与失败计数。
 */
export interface DeliveryPort {
  /** 解析实际目标。 */
  resolveTarget(task: TaskDef): Promise<DeliveryTarget>
  /** 投递；目标非 live 时按配置入 outbox 或 skipped。 */
  deliver(input: DeliveryInput): Promise<DeliveryResult>
}
