/**
 * 调度子模块公共出口。
 *
 * 本任务只导出契约（types）与 cron 内核；store / runner / deliver / service /
 * tools 等模块由后续任务补齐后在此追加导出。装配（mountScheduler）不在本模块，
 * 由插件 `apply` 在任务-07 接入。
 */
export type {
  Clock,
  DeliveryInput,
  DeliveryPort,
  DeliveryResult,
  DeliveryTarget,
  ExecInput,
  ExecResult,
  ExecStrategy,
  ScriptTaskDef,
  TaskDef,
  TaskFailureKind,
  TaskKind,
  TaskRunOutcome,
  TaskScriptResult,
  TextTaskDef,
  Timer,
  TimerHandle,
} from './types.js'

export { isValidCron, localParts, next as nextCronTime, parseCron } from './cron.js'
export type { CronField, CronSchedule } from './cron.js'
