import type { Context } from '@deepseek-ai/cordis'
import { SCHEDULER_TOOL_NAMES } from '../scheduler/tools.js'
import { applyTaskToolProfile } from './profile.js'

export const name = 'task-tools-leader'
export const inject = ['tools', 'agentSchedulerTools']
export function apply(ctx: Context): void {
  applyTaskToolProfile(ctx, 'leader', SCHEDULER_TOOL_NAMES)
}
