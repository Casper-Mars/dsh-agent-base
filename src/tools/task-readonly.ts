import type { Context } from '@deepseek-ai/cordis'
import { applyTaskToolProfile } from './profile.js'

export const name = 'task-tools-readonly'
export const inject = ['tools', 'agentSchedulerTools']
export function apply(ctx: Context): void {
  applyTaskToolProfile(ctx, 'readonly', ['task_list', 'task_get'])
}
