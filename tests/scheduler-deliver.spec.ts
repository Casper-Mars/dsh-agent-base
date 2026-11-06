/**
 * 投递层：目标解析 / producer 消息源 / 内存 outbox / 失败通知回退。
 *
 * 全部使用 fake（agent 注册表、会话持久化、时钟、事件总线），不创建真实
 * Agent、不真实 sleep；TTL 由注入时钟推进，由 `expire` / `flush` 判定。
 */
import { boundContextSummary } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_PENDING_PER_TASK,
  DEFAULT_PENDING_TTL_MS,
  PRODUCER_KIND,
  createDeliveryPort,
  createNoticeMessage,
  type AgentBaseDeliveryPort,
  type CreateDeliveryPortOptions,
  type DeliveryLogger,
} from '../src/scheduler/deliver.js'
import type { DeliveryInput, TaskDef } from '../src/scheduler/types.js'

interface FakeAgent {
  followup: ReturnType<typeof vi.fn>
}

interface Logs {
  info: string[]
  warn: string[]
  error: string[]
  /** 原始日志条目（含 meta），用于断言 fallbackFrom 等结构化字段。 */
  entries: {
    level: 'info' | 'warn' | 'error'
    message: string
    meta?: unknown
  }[]
}

interface Harness {
  port: AgentBaseDeliveryPort
  live: Map<string, FakeAgent>
  logs: Logs
  now: { value: Date }
  addAgent(id: string): FakeAgent
  advance(ms: number): void
}

const T0 = new Date('2026-11-06T09:00:00+08:00')

function makeLogger(logs: Logs): DeliveryLogger {
  const record =
    (level: 'info' | 'warn' | 'error') =>
    (message: string, meta?: unknown) => {
      logs[level].push(message)
      logs.entries.push({ level, message, ...(meta === undefined ? {} : { meta }) })
    }
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  }
}

function setup(
  overrides: Partial<CreateDeliveryPortOptions> = {},
): Harness {
  const live = new Map<string, FakeAgent>()
  const logs: Logs = { info: [], warn: [], error: [], entries: [] }
  const now = { value: new Date(T0) }
  const port = createDeliveryPort({
    agents: { get: (id) => live.get(id) },
    mainSessionId: 'main',
    clock: { now: () => now.value },
    logger: makeLogger(logs),
    ...overrides,
  })
  return {
    port,
    live,
    logs,
    now,
    addAgent(id) {
      const agent: FakeAgent = { followup: vi.fn() }
      live.set(id, agent)
      return agent
    },
    advance(ms) {
      now.value = new Date(now.value.getTime() + ms)
    },
  }
}

function input(patch: Partial<DeliveryInput> = {}): DeliveryInput {
  return {
    taskId: 'task-1',
    text: '定时任务唤醒',
    summary: '定时任务唤醒',
    sessionId: 'main',
    ...patch,
  }
}

function task(patch: Partial<TaskDef> = {}): TaskDef {
  return {
    id: 'task-1',
    name: '示例任务',
    cron: '0 9 * * *',
    enabled: true,
    task_path: 'scripts/job.mjs',
    ...patch,
  } as TaskDef
}

describe('目标解析（D5：与 allowCustomSession 无关）', () => {
  it('任务级 session_id 仍生效并投自定义 session（端口不接收 allowCustomSession）', async () => {
    const h = setup()
    const custom = h.addAgent('sess-custom')

    const target = await h.port.resolveTarget(task({ session_id: 'sess-custom' }))
    expect(target).toEqual({ sessionId: 'sess-custom' })

    const result = await h.port.deliver(
      input({ text: '直达自定义会话', sessionId: target.sessionId }),
    )
    expect(result).toBe('delivered')
    expect(custom.followup).toHaveBeenCalledTimes(1)
    expect(h.live.get('main')).toBeUndefined()
  })

  it('session_id 缺失 → main，且不查持久化', async () => {
    const stat = vi.fn(async () => undefined)
    const h = setup({ sessionPersistence: { stat } })
    await expect(h.port.resolveTarget(task())).resolves.toEqual({
      sessionId: 'main',
    })
    expect(stat).not.toHaveBeenCalled()
  })

  it('session_id 空串 → main，且不查持久化', async () => {
    const stat = vi.fn(async () => undefined)
    const h = setup({ sessionPersistence: { stat } })
    await expect(
      h.port.resolveTarget(task({ session_id: '' })),
    ).resolves.toEqual({ sessionId: 'main' })
    expect(stat).not.toHaveBeenCalled()
  })

  it('未命中且 stat 无快照 → error「不存在」+ 回退 main', async () => {
    const h = setup({
      sessionPersistence: { stat: async () => undefined },
    })
    const target = await h.port.resolveTarget(task({ session_id: 'ghost' }))
    expect(target.sessionId).toBe('main')
    expect(target.fallbackFrom).toBe('ghost')
    expect(target.reason).toContain('不存在')
    expect(h.logs.error.some((m) => m.includes('不存在'))).toBe(true)
  })

  it('未命中但 stat 有快照 → error「未 live」+ 回退 main', async () => {
    const h = setup({
      sessionPersistence: { stat: async () => ({ header: { cwd: '/tmp/ws' } }) },
    })
    const target = await h.port.resolveTarget(task({ session_id: 'asleep' }))
    expect(target.sessionId).toBe('main')
    expect(target.fallbackFrom).toBe('asleep')
    expect(target.reason).toContain('未 live')
    expect(h.logs.error.some((m) => m.includes('未 live'))).toBe(true)
    expect(h.logs.error.some((m) => m.includes('不存在'))).toBe(false)
  })

  it('stat 抛错 → warn 记「无法确认」，回退 main 且不崩', async () => {
    const h = setup({
      sessionPersistence: {
        stat: async () => {
          throw new Error('disk on fire')
        },
      },
    })
    const target = await h.port.resolveTarget(task({ session_id: 'broken' }))
    expect(target.sessionId).toBe('main')
    expect(target.fallbackFrom).toBe('broken')
    expect(target.reason).toContain('无法确认')
    expect(h.logs.warn.some((m) => m.includes('无法确认'))).toBe(true)
    expect(h.logs.warn.some((m) => m.includes('disk on fire'))).toBe(true)
  })

  it('未命中且 main 也不 live → 消息入 outbox（queued）', async () => {
    const h = setup({
      sessionPersistence: { stat: async () => undefined },
    })
    const target = await h.port.resolveTarget(task({ session_id: 'ghost' }))
    expect(
      await h.port.deliver(input({ text: '回退 main', sessionId: target.sessionId })),
    ).toBe('queued')
    expect(h.port.pendingCount('main')).toBe(1)
  })

  it('自定义 session 未命中 → main 实际收到消息（不只解析到 main）', async () => {
    const h = setup({
      sessionPersistence: { stat: async () => undefined },
    })
    const main = h.addAgent('main')
    const target = await h.port.resolveTarget(task({ session_id: 'ghost' }))

    await expect(
      h.port.deliver(
        input({
          text: '任务唤醒正文',
          sessionId: target.sessionId,
          fallbackFrom: target.fallbackFrom,
        }),
      ),
    ).resolves.toBe('delivered')

    expect(main.followup).toHaveBeenCalledTimes(1)
    const message = main.followup.mock.calls[0][0] as {
      content: readonly { text?: string }[]
    }
    expect(message.content[0].text).toBe('任务唤醒正文')
    expect(h.port.pendingCount()).toBe(0)
  })

  it('未接入 sessionPersistence 且自定义未命中 → error + 回退 main', async () => {
    const h = setup()
    const target = await h.port.resolveTarget(task({ session_id: 'ghost' }))
    expect(target.sessionId).toBe('main')
    expect(target.fallbackFrom).toBe('ghost')
    expect(
      h.logs.error.some((m) => m.includes('未接入会话持久化')),
    ).toBe(true)
  })

  it('入队日志的 meta 带 fallbackFrom（P3-4）', async () => {
    const h = setup({
      sessionPersistence: { stat: async () => undefined },
    })
    const target = await h.port.resolveTarget(task({ session_id: 'ghost' }))
    await h.port.deliver(
      input({ sessionId: target.sessionId, fallbackFrom: target.fallbackFrom }),
    )

    const entry = h.logs.entries.find((item) => item.message.includes('内存 outbox'))
    expect(entry?.meta).toMatchObject({ sessionId: 'main', fallbackFrom: 'ghost' })
  })
})

describe('投递与并发去重', () => {
  it('目标 live → followup 收到 notice 消息', async () => {
    const h = setup()
    const agent = h.addAgent('main')
    await expect(
      h.port.deliver(input({ text: '你好', summary: '摘要' })),
    ).resolves.toBe('delivered')

    expect(agent.followup).toHaveBeenCalledTimes(1)
    const message = agent.followup.mock.calls[0][0] as {
      role: string
      content: readonly { type: string; text?: string }[]
      source: { kind: string; form: string; summary: string }
    }
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: '你好' }])
    expect(message.source.kind).toBe(PRODUCER_KIND)
    expect(message.source.kind).not.toBe('plugin')
    expect(message.source.form).toBe('notice')
    expect(message.source.summary).toBe('摘要')
  })

  it('followup 抛错 → error 日志 + skipped，不抛', async () => {
    const h = setup()
    const agent = h.addAgent('main')
    agent.followup.mockImplementation(() => {
      throw new Error('agent closed')
    })
    await expect(h.port.deliver(input())).resolves.toBe('skipped')
    expect(h.logs.error.some((m) => m.includes('agent closed'))).toBe(true)
  })

  it('deliverOnOffline=skip → 目标不可达直接 skipped，不入队', async () => {
    const h = setup({ deliverOnOffline: 'skip' })
    await expect(h.port.deliver(input())).resolves.toBe('skipped')
    expect(h.port.pendingCount()).toBe(0)
  })

  it('并发两次投递同一 text → 一次 delivered、一次 skipped，followup 只 1 次', async () => {
    const h = setup()
    const agent = h.addAgent('main')
    const payload = input({ text: '同一条消息' })

    const results = await Promise.all([
      h.port.deliver(payload),
      h.port.deliver(payload),
    ])
    expect(results.sort()).toEqual(['delivered', 'skipped'])
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('同 taskId 不同正文并发 → 两条都 delivered（去重键含正文）', async () => {
    const h = setup()
    const agent = h.addAgent('main')

    await expect(
      Promise.all([
        h.port.deliver(input({ text: '正文甲' })),
        h.port.deliver(input({ text: '正文乙' })),
      ]),
    ).resolves.toEqual(['delivered', 'delivered'])
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })

  it('不同 taskId 同正文并发 → 两条都 delivered（去重键含 taskId）', async () => {
    const h = setup()
    const agent = h.addAgent('main')

    await expect(
      Promise.all([
        h.port.deliver(input({ taskId: 'task-a', text: '同一段正文' })),
        h.port.deliver(input({ taskId: 'task-b', text: '同一段正文' })),
      ]),
    ).resolves.toEqual(['delivered', 'delivered'])
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })

  it('agents.get 抛错 → deliver 返回 skipped 且不 reject（P3-3）', async () => {
    const h = setup({
      agents: {
        get: () => {
          throw new Error('registry closed')
        },
      },
    })
    await expect(h.port.deliver(input())).resolves.toBe('skipped')
    expect(h.logs.error.some((m) => m.includes('registry closed'))).toBe(true)
  })
})

describe('内存 outbox', () => {
  it('TTL 到期由 expire 丢弃并返回条数', async () => {
    const h = setup()
    await h.port.deliver(input({ text: '一' }))
    await h.port.deliver(input({ text: '二' }))
    expect(h.port.pendingCount()).toBe(2)

    h.advance(DEFAULT_PENDING_TTL_MS - 1)
    expect(h.port.expire()).toBe(0)
    expect(h.port.pendingCount()).toBe(2)

    h.advance(1)
    expect(h.port.expire()).toBe(2)
    expect(h.port.pendingCount()).toBe(0)
    expect(h.logs.warn.filter((m) => m.includes('missed')).length).toBeGreaterThanOrEqual(2)
  })

  it('flush 按入队顺序补投，返回 delivered 计数', async () => {
    const h = setup()
    await h.port.deliver(input({ text: '第一条', sessionId: 's1' }))
    await h.port.deliver(input({ text: '第二条', sessionId: 's1' }))
    await h.port.deliver(input({ text: '第三条', sessionId: 's1' }))
    expect(h.port.pendingCount('s1')).toBe(3)

    const agent = h.addAgent('s1')
    await expect(h.port.flush('s1')).resolves.toEqual({ delivered: 3, missed: 0 })
    expect(
      agent.followup.mock.calls.map(
        (call) =>
          (call[0] as { content: readonly { text?: string }[] }).content[0].text,
      ),
    ).toEqual(['第一条', '第二条', '第三条'])
    expect(h.port.pendingCount()).toBe(0)
  })

  it('flush 时条目已过期 → 丢弃并计 missed，不投递', async () => {
    const h = setup()
    await h.port.deliver(input({ text: '过期消息' }))
    h.advance(DEFAULT_PENDING_TTL_MS)
    const agent = h.addAgent('main')
    await expect(h.port.flush('main')).resolves.toEqual({ delivered: 0, missed: 1 })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('每任务全桶合计上限 20：第 21 条被拒（skipped）', async () => {
    const h = setup()
    for (let i = 0; i < DEFAULT_MAX_PENDING_PER_TASK; i += 1) {
      await expect(
        h.port.deliver(input({ text: `消息-${i}`, sessionId: `off-${i % 2}` })),
      ).resolves.toBe('queued')
    }
    expect(h.port.pendingCount()).toBe(DEFAULT_MAX_PENDING_PER_TASK)

    await expect(
      h.port.deliver(input({ text: '第 21 条', sessionId: 'off-x' })),
    ).resolves.toBe('skipped')
    expect(h.port.pendingCount()).toBe(DEFAULT_MAX_PENDING_PER_TASK)
    expect(h.logs.warn.some((m) => m.includes('missed'))).toBe(true)
  })

  it('过期条目在 expire / flush 前不再占用 20 条额度', async () => {
    const h = setup({ pendingTtlMs: 1000 })
    for (let i = 0; i < DEFAULT_MAX_PENDING_PER_TASK; i += 1) {
      await expect(
        h.port.deliver(input({ text: `旧消息-${i}`, sessionId: `off-${i % 2}` })),
      ).resolves.toBe('queued')
    }
    expect(h.port.pendingCount()).toBe(DEFAULT_MAX_PENDING_PER_TASK)

    // 全部过期但尚未 expire / flush：新消息不应被 overflow 拒绝；
    // 入队入口会先物理清扫该任务的过期条目（避免无界堆积），因此队列只剩新消息。
    h.advance(1000)
    await expect(
      h.port.deliver(input({ text: '过期后的新消息', sessionId: 'off-new' })),
    ).resolves.toBe('queued')
    expect(h.port.pendingCount()).toBe(1)
    expect(h.port.pendingCount('off-new')).toBe(1)
    // 其它任务的过期条目不受本次定向清扫影响，仍由 expire 统一处理。
    expect(h.port.expire()).toBe(0)
  })

  it('按 sessionId 分桶：flush 一个桶不影响另一个', async () => {
    const h = setup()
    await h.port.deliver(input({ text: '给 s1', sessionId: 's1' }))
    await h.port.deliver(input({ text: '给 s2', sessionId: 's2' }))

    const s1 = h.addAgent('s1')
    await expect(h.port.flush('s1')).resolves.toEqual({ delivered: 1, missed: 0 })
    expect(s1.followup).toHaveBeenCalledTimes(1)
    expect(h.port.pendingCount('s2')).toBe(1)
    expect(h.port.pendingCount('s1')).toBe(0)
  })

  it('flush 时 followup 抛错 → 计 missed 并移除条目，不抛', async () => {
    const h = setup()
    await h.port.deliver(input({ text: '补投失败' }))
    const agent = h.addAgent('main')
    agent.followup.mockImplementation(() => {
      throw new Error('agent closed')
    })

    await expect(h.port.flush('main')).resolves.toEqual({
      delivered: 0,
      missed: 1,
    })
    expect(h.port.pendingCount()).toBe(0)
    expect(h.logs.error.some((m) => m.includes('补投到'))).toBe(true)
  })

  it('flush 时仍不可达 → 保留条目等待下次补投', async () => {
    const h = setup()
    await h.port.deliver(input({ text: '继续等待' }))
    await expect(h.port.flush('main')).resolves.toEqual({ delivered: 0, missed: 0 })
    expect(h.port.pendingCount('main')).toBe(1)
  })
})

describe('events 订阅', () => {
  it('agent/created 触发对应桶 flush；dispose 后取消订阅且清空 outbox', async () => {
    const callbacks: ((sessionId: string) => void)[] = []
    const unsubscribe = vi.fn()
    const events = {
      on: (_event: 'agent/created', cb: (sessionId: string) => void) => {
        callbacks.push(cb)
        return unsubscribe
      },
    }
    const h = setup({ events })
    await h.port.deliver(input({ text: '等 agent 起来', sessionId: 'later' }))
    expect(callbacks).toHaveLength(1)

    const agent = h.addAgent('later')
    callbacks[0]('later')
    await Promise.resolve()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(h.port.pendingCount('later')).toBe(0)

    h.live.delete('later')
    await h.port.deliver(input({ text: 'dispose 前入队', sessionId: 'later' }))
    expect(h.port.pendingCount('later')).toBe(1)
    h.port.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.port.pendingCount()).toBe(0)

    callbacks[0]('later')
    await Promise.resolve()
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })
})

describe('失败通知（deliverNotice）', () => {
  it('目标不可达（skip 策略）→ 改投 main 一次', async () => {
    const h = setup({ deliverOnOffline: 'skip' })
    const main = h.addAgent('main')
    await expect(
      h.port.deliverNotice(
        input({ text: '任务失败', summary: '失败', sessionId: 'ghost' }),
      ),
    ).resolves.toBe('delivered')
    expect(main.followup).toHaveBeenCalledTimes(1)
    const message = main.followup.mock.calls[0][0] as {
      content: readonly { text?: string }[]
    }
    expect(message.content[0].text).toBe('任务失败')
  })

  it('默认 queue 下目标离线 → 改投 main（main 实际收到 1 次，不留重复副本）', async () => {
    const h = setup()
    const main = h.addAgent('main')

    await expect(
      h.port.deliverNotice(input({ text: '任务失败', sessionId: 'ghost' })),
    ).resolves.toBe('delivered')

    expect(main.followup).toHaveBeenCalledTimes(1)
    const message = main.followup.mock.calls[0][0] as {
      content: readonly { text?: string }[]
    }
    expect(message.content[0].text).toBe('任务失败')
    // 回退成功后撤销自定义桶里的副本，避免日后 flush 重复通知。
    expect(h.port.pendingCount('ghost')).toBe(0)
    // 回退日志带 fallbackFrom，便于排障。
    const warn = h.logs.entries.find((item) => item.message.includes('改投 main'))
    expect(warn?.meta).toMatchObject({ sessionId: 'ghost', fallbackFrom: 'ghost' })
  })

  it('默认 queue 下目标与 main 均离线 → queued 且 main 桶 1 条', async () => {
    const h = setup()
    await expect(
      h.port.deliverNotice(input({ text: '任务失败', sessionId: 'ghost' })),
    ).resolves.toBe('queued')
    expect(h.port.pendingCount('main')).toBe(1)
    expect(h.port.pendingCount('ghost')).toBe(0)
    expect(h.port.pendingCount()).toBe(1)
  })

  it('目标投递失败且 main 也未 live → queued', async () => {
    const h = setup()
    const broken = h.addAgent('broken')
    broken.followup.mockImplementation(() => {
      throw new Error('agent closed')
    })
    await expect(
      h.port.deliverNotice(input({ text: '失败通知', sessionId: 'broken' })),
    ).resolves.toBe('queued')
    expect(h.port.pendingCount('main')).toBe(1)
  })

  it('目标是 main 时不重复回退', async () => {
    const h = setup({ deliverOnOffline: 'skip' })
    await expect(
      h.port.deliverNotice(input({ sessionId: 'main' })),
    ).resolves.toBe('skipped')
    expect(h.port.pendingCount()).toBe(0)
    expect(h.logs.warn.some((m) => m.includes('改投 main'))).toBe(false)
  })

  it('目标是 main 且投递抛错 → skipped，不重复回退', async () => {
    const h = setup()
    const agent = h.addAgent('main')
    agent.followup.mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(h.port.deliverNotice(input())).resolves.toBe('skipped')
    expect(h.logs.error.some((m) => m.includes('boom'))).toBe(true)
    expect(h.logs.warn.some((m) => m.includes('改投 main'))).toBe(false)
    expect(h.port.pendingCount()).toBe(0)
  })

  it('agents.get 抛错 → 记为投递失败并尝试回退，不抛出（P3-3）', async () => {
    const h = setup({
      agents: {
        get: () => {
          throw new Error('registry closed')
        },
      },
    })
    await expect(
      h.port.deliverNotice(input({ text: '失败通知', sessionId: 'ghost' })),
    ).resolves.toBe('skipped')
    expect(h.logs.error.filter((m) => m.includes('registry closed')).length).toBe(2)
    expect(h.logs.warn.some((m) => m.includes('改投 main'))).toBe(true)
  })

  it('并发投递同一条失败通知 → 仅 1 次 delivered，main 不收到重复回退（P2-1）', async () => {
    const h = setup()
    const custom = h.addAgent('sess-live')
    const main = h.addAgent('main')
    const payload = input({ text: '同一条失败通知', sessionId: 'sess-live' })

    const results = await Promise.all([
      h.port.deliverNotice(payload),
      h.port.deliverNotice(payload),
    ])

    expect(results.sort()).toEqual(['delivered', 'skipped'])
    expect(custom.followup).toHaveBeenCalledTimes(1)
    expect(main.followup).not.toHaveBeenCalled()
    // 去重跳过不得被误判为投递失败。
    expect(h.logs.warn.some((m) => m.includes('改投 main'))).toBe(false)
  })
})

describe('flush 健壮性', () => {
  it('flush 时 agents.get 抛错 → error 日志 + 保留条目，不抛（P3-3）', async () => {
    const live = new Map<string, FakeAgent>()
    const logs: Logs = { info: [], warn: [], error: [], entries: [] }
    const now = { value: new Date(T0) }
    let broken = false
    const port = createDeliveryPort({
      agents: {
        get: (id) => {
          if (broken) throw new Error('registry closed')
          return live.get(id)
        },
      },
      mainSessionId: 'main',
      clock: { now: () => now.value },
      logger: makeLogger(logs),
    })

    await expect(port.deliver(input({ text: '待补投' }))).resolves.toBe('queued')
    broken = true

    await expect(port.flush('main')).resolves.toEqual({ delivered: 0, missed: 0 })
    expect(port.pendingCount('main')).toBe(1)
    expect(logs.error.some((m) => m.includes('registry closed'))).toBe(true)
  })

  it('flush 保留日志的 meta 带 fallbackFrom（P3-4）', async () => {
    const h = setup()
    await h.port.deliver(input({ text: '补投', fallbackFrom: 'sess-custom' }))

    await expect(h.port.flush('main')).resolves.toEqual({ delivered: 0, missed: 0 })
    const warn = h.logs.entries.find((item) => item.message.includes('仍不可达'))
    expect(warn?.meta).toMatchObject({
      sessionId: 'main',
      fallbackFrom: 'sess-custom',
    })
  })
})

describe('消息源', () => {
  it('createNoticeMessage：kind / form / summary / 正文', () => {
    const message = createNoticeMessage('正文内容', '一行摘要', 'trace-1')
    expect(message.role).toBe('user')
    expect(message.source).toEqual({
      kind: 'dsh-agent-base',
      form: 'notice',
      summary: '一行摘要',
      traceId: 'trace-1',
    })
    expect(message.content).toEqual([{ type: 'text', text: '正文内容' }])
    expect(Object.isFrozen(message)).toBe(true)
  })

  it('summary 缺省按 boundContextSummary 截断；无 trace 不写字段', () => {
    const text = '很长的正文'.repeat(50)
    const message = createNoticeMessage(text)
    expect(message.source.summary).toBe(boundContextSummary(text))
    expect(message.source.summary.length).toBeLessThanOrEqual(120)
    expect('traceId' in message.source).toBe(false)
  })
})

describe('D5/D6 验收补充（测试者追加）', () => {
  it('默认常量字面量：TTL 10 分钟、每任务上限 20 条', () => {
    // 用字面量而非常量断言，避免实现改常量后测试随之“自适应”而失去约束。
    expect(DEFAULT_PENDING_TTL_MS).toBe(600_000)
    expect(DEFAULT_MAX_PENDING_PER_TASK).toBe(20)
  })

  it('outbox 已满（overflow）时 deliverNotice 不回退 main（防重复投递）', async () => {
    const h = setup()
    const main = h.addAgent('main')

    // 同一任务填满 20 条（目标 ghost 未 live，全部入 outbox）。
    for (let i = 0; i < DEFAULT_MAX_PENDING_PER_TASK; i += 1) {
      await expect(
        h.port.deliver(input({ taskId: 'task-full', text: `消息-${i}`, sessionId: 'ghost' })),
      ).resolves.toBe('queued')
    }
    expect(h.port.pendingCount()).toBe(DEFAULT_MAX_PENDING_PER_TASK)

    await expect(
      h.port.deliverNotice(
        input({ taskId: 'task-full', text: '溢出的失败通知', sessionId: 'ghost' }),
      ),
    ).resolves.toBe('skipped')

    // overflow 不得触发回退：main 不收到任何消息，outbox 不增长，也不写“改投 main”。
    expect(main.followup).not.toHaveBeenCalled()
    expect(h.port.pendingCount()).toBe(DEFAULT_MAX_PENDING_PER_TASK)
    expect(h.logs.warn.some((m) => m.includes('改投 main'))).toBe(false)
  })

  it('正常投递（无回退）日志 meta 不含 fallbackFrom 字段', async () => {
    const h = setup()
    await h.port.deliver(input({ text: '普通入队', sessionId: 'offline' }))

    const entry = h.logs.entries.find((item) => item.message.includes('内存 outbox'))
    expect(entry?.meta).toMatchObject({ taskId: 'task-1', sessionId: 'offline' })
    expect(
      Object.prototype.hasOwnProperty.call(entry?.meta, 'fallbackFrom'),
    ).toBe(false)
  })

  it('dispose 后无悬挂定时器（全过程未创建 timer）', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      await h.port.deliver(input({ text: '待补投', sessionId: 'later' }))
      expect(vi.getTimerCount()).toBe(0)

      h.port.dispose()
      expect(vi.getTimerCount()).toBe(0)
      expect(h.port.pendingCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('目标 live 但 followup 抛错 → 失败通知回退 main 一次并 delivered', async () => {
    const h = setup()
    const broken = h.addAgent('broken')
    broken.followup.mockImplementation(() => {
      throw new Error('agent closed')
    })
    const main = h.addAgent('main')

    await expect(
      h.port.deliverNotice(input({ text: '失败通知正文', sessionId: 'broken' })),
    ).resolves.toBe('delivered')

    expect(main.followup).toHaveBeenCalledTimes(1)
    expect(h.port.pendingCount()).toBe(0)
    const warn = h.logs.entries.find((item) => item.message.includes('改投 main'))
    expect(warn?.meta).toMatchObject({ sessionId: 'broken', fallbackFrom: 'broken' })
  })
})
