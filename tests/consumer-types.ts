/**
 * 消费方类型检查（只编译，不参与 vitest 运行）。
 *
 * 证明 import 本包后，真实 Context 上的 `ctx.agentBase` 与两个 getter
 * 可直接使用且类型正确。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentBaseService } from '../src/index.js'
import type { TaskRunOutcome } from '../src/scheduler/index.js'

declare const ctx: Context

const cwd: string = ctx.agentBase.workspaceCwd
const id = ctx.agentBase.mainSessionId
const svc: AgentBaseService = ctx.agentBase

void cwd
void id
void svc

// ---------------------------------------------------------------------------
// 契约回归：`TaskRunOutcome.missed.scheduledAt` 为必填
//
// 依据：missed 表示离线队列条目已过期，该条目必然有过「原定投递时刻」；
// 且 `task_run_now` 的 output schema 的 missed 分支把 scheduledAt 列为 required。
// 类型层若仍允许缺省，二者口径分裂，构造出的结局会在工具输出校验期被判
// `must match exactly one oneOf branch (matched 0)`。
//
// 下面的 `@ts-expect-error` 是回归守卫：一旦有人把 scheduledAt 放宽回可选，
// 该指令会因「未使用」报 TS2578，`pnpm typecheck:consumer` 立刻失败。
// @ts-expect-error missed 分支的 scheduledAt 为必填（Date），不可缺省
const missedWithoutScheduledAt: TaskRunOutcome = {
  kind: 'missed',
  reason: '离线队列条目过期',
}

const missedWithScheduledAt: TaskRunOutcome = {
  kind: 'missed',
  reason: '离线队列条目过期',
  scheduledAt: new Date(0),
}

void missedWithoutScheduledAt
void missedWithScheduledAt
