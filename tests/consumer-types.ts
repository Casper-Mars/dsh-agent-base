/**
 * 消费方类型检查（只编译，不参与 vitest 运行）。
 *
 * 证明 import 本包后，真实 Context 上的 `ctx.agentBase` 与两个 getter
 * 可直接使用且类型正确。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentBaseService } from '../src/index.js'

declare const ctx: Context

const cwd: string = ctx.agentBase.workspaceCwd
const id = ctx.agentBase.mainSessionId
const svc: AgentBaseService = ctx.agentBase

void cwd
void id
void svc
