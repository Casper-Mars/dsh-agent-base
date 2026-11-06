/**
 * `ctx.agentScheduler`：调度能力的**只读诊断服务**。
 *
 * 包装既有的 {@link SchedulerService}，不改变其行为，只把稳定查询面暴露给
 * 其它插件 / 运维入口：
 *   - `scheduledIds` / `isRunning` / `lastOutcome` / `status` 只读查询；
 *   - `reload` / `runNow` 是调度器本来就有的显式操作，这里仅转发。
 *
 * 不暴露 store / state / delivery / timer，也不提供创建、修改、删除任务的入口
 * ——写能力只属于 8 个 `task_*` 工具。
 *
 * 注：Cordis 会把服务实例包在追踪 Proxy 中，`#` 私有字段在 Proxy 下不可访问；
 * 内部引用因此放在构造时定义的 symbol 属性上，避免 getter 的 `this` 被替换后
 * 丢失状态。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SchedulerService } from './service.js'
import type { TaskStatus } from './state.js'
import type { TaskRunOutcome } from './types.js'

const SCHEDULER = Symbol('agentScheduler.scheduler')

/** 只读诊断服务。 */
export class AgentSchedulerService extends Service {
  declare readonly [SCHEDULER]: SchedulerService

  constructor(ctx: Context, scheduler: SchedulerService) {
    super(ctx, 'agentScheduler')
    Object.defineProperty(this, SCHEDULER, {
      value: scheduler,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  /** 已排定的任务 id（升序，只读快照）。 */
  get scheduledIds(): readonly string[] {
    return this[SCHEDULER].scheduledIds
  }

  /** 任务是否正在执行（单飞锁）。 */
  isRunning(id: string): boolean {
    return this[SCHEDULER].isRunning(id)
  }

  /** 立即执行一次（与定时触发共用单飞锁）。 */
  runNow(id: string): Promise<TaskRunOutcome> {
    return this[SCHEDULER].runNow(id)
  }

  /** 重新加载任务清单。 */
  reload(): void {
    this[SCHEDULER].reload()
  }

  /** 最近一次触发结局（含单飞跳过）；从未触发返回 `undefined`。 */
  lastOutcome(id: string): TaskRunOutcome | undefined {
    return this[SCHEDULER].lastOutcome(id)
  }

  /**
   * 任务失败 / 成功状态；任务不存在或 id 非法时返回 `undefined`。
   *
   * 不把 `TaskStatus` 的 `taskId` 字段透出：诊断服务按参数定位任务，返回体只
   * 保留失败计数与时间戳，避免调用方依赖内部视图形状。
   */
  status(id: string):
    | {
        readonly consecutiveFailures: number
        readonly lastFailureKind?: TaskStatus['lastFailureKind']
        readonly lastFailureReason?: string
        readonly lastFailureAt?: string
        readonly lastSuccessAt?: string
        readonly nextNotifyAt?: string
      }
    | undefined {
    let exists = false
    try {
      exists = this[SCHEDULER].store.get(id) !== undefined
    } catch {
      return undefined
    }
    if (!exists) return undefined

    try {
      const status = this[SCHEDULER].status(id)
      return {
        consecutiveFailures: status.consecutiveFailures,
        ...(status.lastFailureKind === undefined
          ? {}
          : { lastFailureKind: status.lastFailureKind }),
        ...(status.lastFailureReason === undefined
          ? {}
          : { lastFailureReason: status.lastFailureReason }),
        ...(status.lastFailureAt === undefined
          ? {}
          : { lastFailureAt: status.lastFailureAt }),
        ...(status.lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: status.lastSuccessAt }),
        ...(status.nextNotifyAt === undefined
          ? {}
          : { nextNotifyAt: status.nextNotifyAt }),
      }
    } catch {
      return undefined
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentScheduler: AgentSchedulerService
  }
}
