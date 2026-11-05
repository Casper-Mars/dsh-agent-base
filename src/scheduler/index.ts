/**
 * 调度子模块公共出口。
 *
 * 本任务在契约（types）与 cron 内核之上追加 store / state / text / validate /
 * runner / failure 的公共面；deliver / service / tools 等模块由后续任务补齐后
 * 在此追加。装配（mountScheduler）不在本模块，由插件 `apply` 在任务-07 接入。
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

export {
  DEFAULT_TASKS_SUBDIR,
  MAX_COOLDOWN_MS,
  TASK_FILE_EXT,
  TASK_ID_PATTERN,
  TaskStore,
  TaskStoreError,
  assertTaskId,
  createTaskStore,
  isTaskDef,
  resolveTasksDir,
} from './store.js'
export type { TaskListResult, TaskStoreLogger, TaskStoreOptions } from './store.js'

export {
  FAILURE_NOTIFY_INTERVAL_MS,
  STATE_VERSION,
  StateStore,
  createStateStore,
  defaultStatePath,
  formatIsoWithOffset,
} from './state.js'
export type {
  SchedulerState,
  StateStoreLogger,
  StateStoreOptions,
  TaskFailureState,
  TaskStatus,
} from './state.js'

export {
  DEFAULT_MAX_DELIVER_CHARS,
  SUMMARY_MAX,
  deriveSummary,
  renderText,
  splitGraphemes,
  truncateText,
} from './text.js'
export type { RenderTextOptions } from './text.js'

export {
  ALLOWED_SCRIPT_EXTENSIONS,
  TaskPathError,
  resolveScriptPath,
  validateScript,
  validateScriptFile,
  validateScriptShape,
} from './validate.js'
export type {
  ScriptFileFs,
  ScriptValidationDeps,
  ScriptValidationResult,
  TaskPathFailureKind,
} from './validate.js'

export {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
  KILL_GRACE_MS,
  STDOUT_TRUNCATION_MARKER,
  createNodeExecStrategy,
  parseTaskOutput,
  truncationDetail,
} from './runner.js'
export type { NodeExecStrategyOptions } from './runner.js'

export {
  KNOWN_FAILURE_KINDS,
  buildFailureNotice,
  describeFailure,
  formatInTimeZone,
  processFailure,
  processSuccess,
} from './failure.js'
export type {
  FailureLogger,
  FailureNoticeInput,
  FailureStatePort,
  ProcessFailureDeps,
  ProcessFailureResult,
  ProcessSuccessDeps,
  TaskFailureInput,
} from './failure.js'

export {
  DEFAULT_MAX_PENDING_PER_TASK,
  DEFAULT_PENDING_TTL_MS,
  PRODUCER_KIND,
  createDeliveryPort,
  createNoticeMessage,
} from './deliver.js'
export type {
  AgentBaseDeliveryPort,
  CreateDeliveryPortOptions,
  DeliveryAgentsLike,
  DeliveryEventsLike,
  DeliveryLogger,
  DeliveryPersistenceLike,
  NoticeMessageSource,
  NoticeUserMessage,
} from './deliver.js'
