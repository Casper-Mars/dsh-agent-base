import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

interface SchedulerToolsService {
  createTools(): ToolDefinition[]
}

export function applyTaskToolProfile(ctx: Context, profile: string, names: readonly string[]): void {
  const service = (ctx as unknown as { agentSchedulerTools?: SchedulerToolsService }).agentSchedulerTools
  if (service === undefined) throw new Error('agentSchedulerTools 服务未就绪')
  const wanted = new Set(names)
  ctx.effect(() => {
    const disposers = service.createTools()
      .filter(tool => wanted.has(tool.name))
      .map(tool => ctx.tools.register(tool))
    return () => {
      for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.()
    }
  }, `tasks.tools.${profile}`)
}
