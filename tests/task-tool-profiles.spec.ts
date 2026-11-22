import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SCHEDULER_TOOL_NAMES } from '../src/scheduler/tools.js'
import { apply as applyLeader } from '../src/tools/task-leader.js'
import { apply as applyReadonly } from '../src/tools/task-readonly.js'

function makeContext() {
  const registrations: string[] = []
  const disposers: Array<() => void> = []
  const definitions = SCHEDULER_TOOL_NAMES.map(name => ({ name } as ToolDefinition))
  const ctx = {
    effect(execute: () => (() => void) | void) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
      return { dispose: async () => {} }
    },
    tools: {
      register(tool: ToolDefinition) {
        registrations.push(tool.name)
        return () => {
          const index = registrations.indexOf(tool.name)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    agentSchedulerTools: { createTools: () => definitions },
  } as unknown as Context
  return { ctx, registrations, disposeAll: () => { for (const dispose of [...disposers].reverse()) dispose() } }
}

describe('task_* 工具 preset 子路径', () => {
  it('leader 注册 8 个 task_*', () => {
    const { ctx, registrations, disposeAll } = makeContext()
    applyLeader(ctx)
    expect(registrations).toEqual([...SCHEDULER_TOOL_NAMES])
    disposeAll()
    expect(registrations).toEqual([])
  })

  it('readonly 只注册 task_list / task_get', () => {
    const { ctx, registrations } = makeContext()
    applyReadonly(ctx)
    expect(registrations).toEqual(['task_list', 'task_get'])
  })
})
