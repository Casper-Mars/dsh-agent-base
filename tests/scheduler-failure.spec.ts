/**
 * 失败归类 / 通知文案 / 24h 窗口状态机。
 *
 * 状态用真实 `StateStore`（临时目录）验证「跑完即落盘」的窗口语义；
 * 时刻全部注入，禁止真实 sleep。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FAILURE_NOTIFY_INTERVAL_MS,
  StateStore,
} from '../src/scheduler/state.js'
import {
  buildFailureNotice,
  describeFailure,
  formatInTimeZone,
  processFailure,
  processSuccess,
  type ProcessFailureDeps,
} from '../src/scheduler/failure.js'
import type { TaskDef, TaskFailureKind } from '../src/scheduler/types.js'

const roots: string[] = []

function tempStore(warnings: string[] = []): StateStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-base-failure-'))
  roots.push(dir)
  return new StateStore({
    path: join(dir, 'scheduler.json'),
    logger: { warn: (message) => warnings.push(message) },
  })
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

const T0 = new Date('2026-11-06T09:00:00+08:00')
const HOUR = 60 * 60 * 1000

function at(offsetMs: number, base: Date = T0): Date {
  return new Date(base.getTime() + offsetMs)
}

const TASK: TaskDef = {
  id: 'demo',
  name: '示例任务',
  cron: '0 9 * * *',
  enabled: true,
  task_path: 'scripts/job.mjs',
}

const TEXT_TASK: TaskDef = {
  id: 'txt',
  name: '文本任务',
  cron: '0 9 * * *',
  enabled: true,
  kind: 'text',
  text: 'hello',
}

interface Harness {
  deps: ProcessFailureDeps
  notices: string[]
  infos: string[]
  warns: string[]
}

function harness(
  store: StateStore,
  now: Date,
  options: { deliver?: (text: string) => Promise<boolean>; timezone?: string } = {},
): Harness {
  const notices: string[] = []
  const infos: string[] = []
  const warns: string[] = []
  const deps: ProcessFailureDeps = {
    state: store,
    now,
    deliverNotice: async (text) => {
      notices.push(text)
      return options.deliver === undefined ? true : options.deliver(text)
    },
    timezone: options.timezone ?? 'Asia/Shanghai',
    tasksDir: 'custom/tasks',
    scriptPath: '/abs/scripts/job.mjs',
    logger: {
      info: (message) => infos.push(message),
      warn: (message) => warns.push(message),
    },
  }
  return { deps, notices, infos, warns }
}

describe('失败归类文案', () => {
  it('五类各有可读阶段且互不相同', () => {
    const kinds: TaskFailureKind[] = ['missing', 'runtime', 'exec', 'parse', 'deliver']
    const texts = kinds.map((kind) => describeFailure(kind))
    expect(new Set(texts).size).toBe(5)
    expect(describeFailure('missing')).toContain('任务程序不可用')
    expect(describeFailure('runtime')).toContain('运行时')
    expect(describeFailure('exec')).toContain('执行')
    expect(describeFailure('parse')).toContain('解析')
    expect(describeFailure('deliver')).toContain('投递')
  })

  it('detail 追加在阶段之后，空白 detail 被忽略', () => {
    expect(describeFailure('exec', 'exitCode=1')).toContain('exitCode=1')
    expect(describeFailure('exec', '   ')).toBe(describeFailure('exec'))
    expect(describeFailure('exec')).not.toContain('：')
  })
})

describe('时间渲染', () => {
  it('按传入时区渲染带偏移 ISO（UTC 与 +08:00 对同一时刻一致）', () => {
    expect(formatInTimeZone(T0, 'Asia/Shanghai')).toBe('2026-11-06T09:00:00+08:00')
    expect(formatInTimeZone(T0, 'UTC')).toBe('2026-11-06T01:00:00+00:00')
  })
})

describe('失败通知文案', () => {
  const status = {
    consecutiveFailures: 3,
    firstFailureAt: '2026-11-06T09:00:00+08:00',
    lastFailureAt: '2026-11-08T09:00:00+08:00',
  } as const

  it('包含任务、类型、阶段、原因、计数、时刻、路径（script）', () => {
    const notice = buildFailureNotice({
      task: TASK,
      failureKind: 'exec',
      detail: '进程异常退出（exitCode=1）',
      status,
      timezone: 'Asia/Shanghai',
      nextNotifyAt: at(FAILURE_NOTIFY_INTERVAL_MS, new Date('2026-11-08T09:00:00+08:00')),
      tasksDir: 'custom/tasks',
      scriptPath: '/abs/scripts/job.mjs',
    })

    expect(notice).toContain('【定时任务失败】示例任务（demo）')
    expect(notice).toContain('类型：script')
    expect(notice).toContain('阶段：任务执行失败')
    expect(notice).toContain('原因：进程异常退出（exitCode=1）')
    expect(notice).toContain(
      '连续失败：3 次（首次 2026-11-06T09:00:00+08:00 / 最近 2026-11-08T09:00:00+08:00）',
    )
    expect(notice).toContain('下次最早通知：2026-11-09T09:00:00+08:00')
    expect(notice).toContain('任务定义：custom/tasks/demo.json')
    expect(notice).toContain('任务程序：/abs/scripts/job.mjs')
  })

  it('缺省 tasksDir 为 .agent-base/tasks', () => {
    const notice = buildFailureNotice({
      task: TASK,
      failureKind: 'missing',
      status,
      timezone: 'Asia/Shanghai',
      nextNotifyAt: T0,
    })
    expect(notice).toContain(`任务定义：${join('.agent-base', 'tasks', 'demo.json')}`)
  })

  it('text 任务不输出任务程序行', () => {
    const notice = buildFailureNotice({
      task: TEXT_TASK,
      failureKind: 'deliver',
      detail: '目标会话不可达',
      status,
      timezone: 'Asia/Shanghai',
      nextNotifyAt: T0,
    })
    expect(notice).toContain('类型：text')
    expect(notice).not.toContain('任务程序')
  })

  it('时刻按任务时区渲染，不受进程本地时区影响', () => {
    const notice = buildFailureNotice({
      task: TASK,
      failureKind: 'parse',
      status: {
        consecutiveFailures: 1,
        firstFailureAt: '2026-11-06T01:00:00+00:00',
        lastFailureAt: '2026-11-06T01:00:00+00:00',
      },
      timezone: 'UTC',
      nextNotifyAt: at(HOUR, T0),
    })
    expect(notice).toContain('首次 2026-11-06T01:00:00+00:00')
    expect(notice).toContain('下次最早通知：2026-11-06T02:00:00+00:00')
    expect(notice).not.toContain('+08:00')
  })

  it('首次 / 最近时刻缺失时用占位符', () => {
    const notice = buildFailureNotice({
      task: TASK,
      failureKind: 'exec',
      status: { consecutiveFailures: 1 },
      timezone: 'Asia/Shanghai',
      nextNotifyAt: T0,
    })
    expect(notice).toContain('首次 — / 最近 —')
  })
})

describe('24h 通知窗口（冻结时钟）', () => {
  it('首次通知 → 窗口内不通知 → 恰好 24h 再通知', async () => {
    const store = tempStore()

    const first = await processFailure(TASK, { kind: 'exec', detail: 'exitCode=1' }, harness(store, T0).deps)
    expect(first.notified).toBe(true)
    expect(store.get('demo')?.lastNotifiedAt).toBeDefined()

    const withinHour = harness(store, at(HOUR))
    const second = await processFailure(TASK, { kind: 'exec', detail: 'exitCode=1' }, withinHour.deps)
    expect(second.notified).toBe(false)
    expect(second.notice).toBeUndefined()
    expect(second.status.consecutiveFailures).toBe(2) // 计数照常累加
    expect(withinHour.notices).toHaveLength(0)
    expect(withinHour.infos.join('\n')).toContain('24h 窗口')

    const almost = await processFailure(
      TASK,
      { kind: 'exec' },
      harness(store, at(FAILURE_NOTIFY_INTERVAL_MS - 1)).deps,
    )
    expect(almost.notified).toBe(false)

    const exact = harness(store, at(FAILURE_NOTIFY_INTERVAL_MS))
    const fourth = await processFailure(TASK, { kind: 'exec' }, exact.deps)
    expect(fourth.notified).toBe(true)
    expect(exact.notices).toHaveLength(1)
  })

  it('超过 24h 可通知', async () => {
    const store = tempStore()
    await processFailure(TASK, { kind: 'missing' }, harness(store, T0).deps)

    const later = harness(store, at(FAILURE_NOTIFY_INTERVAL_MS + 1))
    const result = await processFailure(TASK, { kind: 'missing' }, later.deps)
    expect(result.notified).toBe(true)
    expect(later.notices).toHaveLength(1)
  })

  it('不同任务的窗口互不影响', async () => {
    const store = tempStore()
    const other: TaskDef = { ...TASK, id: 'other', name: '另一个' }
    await processFailure(TASK, { kind: 'exec' }, harness(store, T0).deps)

    const otherRun = harness(store, at(HOUR))
    const result = await processFailure(other, { kind: 'exec' }, otherRun.deps)
    expect(result.notified).toBe(true)
  })
})

describe('投递失败边界', () => {
  it('deliverNotice 返回 false → 不 markNotified，下次仍可通知', async () => {
    const store = tempStore()
    const failed = harness(store, T0, { deliver: async () => false })
    const first = await processFailure(TASK, { kind: 'exec' }, failed.deps)

    expect(first.notified).toBe(false)
    expect(first.notice).toBeDefined()
    expect(first.error).toContain('false')
    expect(store.get('demo')?.lastNotifiedAt).toBeUndefined()
    expect(store.shouldNotify('demo', at(HOUR))).toBe(true)

    const retry = harness(store, at(HOUR))
    const second = await processFailure(TASK, { kind: 'exec' }, retry.deps)
    expect(second.notified).toBe(true)
    expect(retry.notices).toHaveLength(1)
  })

  it('deliverNotice 抛错 → 不抛出、不 markNotified，错误进返回值', async () => {
    const store = tempStore()
    const failed = harness(store, T0, {
      deliver: async () => {
        throw new Error('network down')
      },
    })
    const result = await processFailure(TASK, { kind: 'deliver' }, failed.deps)

    expect(result.notified).toBe(false)
    expect(result.error).toContain('network down')
    expect(store.get('demo')?.lastNotifiedAt).toBeUndefined()
  })

  it('状态写入异常时仍生成通知（不中断调度）', async () => {
    const deps = harness(tempStore(), T0).deps
    const broken: ProcessFailureDeps = {
      ...deps,
      state: {
        recordFailure() {
          throw new Error('disk full')
        },
        shouldNotify: () => true,
        markNotified: () => ({
          taskId: 'demo',
          consecutiveFailures: 1,
        }),
      },
    }
    const result = await processFailure(TASK, { kind: 'exec' }, broken)
    expect(result.notified).toBe(true)
    expect(result.notice).toContain('连续失败：1 次')
  })
})

describe('恢复路径', () => {
  it('processSuccess 清零失败计数，且不产生任何投递', async () => {
    const store = tempStore()
    const failed = harness(store, T0)
    await processFailure(TASK, { kind: 'exec' }, failed.deps)
    expect(store.get('demo')?.consecutiveFailures).toBe(1)

    const deliveredBefore = failed.notices.length
    const result = processSuccess('demo', { state: store, now: at(HOUR) })

    expect(result).toBeUndefined() // 返回 void：没有可投递文本
    expect(failed.notices).toHaveLength(deliveredBefore) // 投递次数不变
    expect(store.get('demo')?.consecutiveFailures).toBe(0)
    expect(store.get('demo')?.lastSuccessAt).toBeDefined()
  })

  it('恢复后再失败：24h 窗口仍生效（lastNotifiedAt 不被成功清除）', async () => {
    const store = tempStore()
    await processFailure(TASK, { kind: 'exec' }, harness(store, T0).deps)
    processSuccess('demo', { state: store, now: at(HOUR) })

    const again = harness(store, at(2 * HOUR))
    const result = await processFailure(TASK, { kind: 'exec' }, again.deps)
    expect(result.notified).toBe(false)
    expect(again.notices).toHaveLength(0)
  })
})
