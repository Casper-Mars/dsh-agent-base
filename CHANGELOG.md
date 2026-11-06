# Changelog

本文件格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-06

新增定时调度子系统。本版本为**新增能力**，既有的固定 workspace 解析、main session
校验与 `ctx.agentBase` 只读服务契约保持不变。

### Added

- **cron 内核**（`src/scheduler/cron.ts`）：5 段 cron（分 时 日 月 周）解析与下一触发时刻计算，
  支持 `*`、`?`（仅日 / 周）、列表 / 区间 / 步进、英文月份与星期缩写、周日 `0` 或 `7`；
  DOM 与 DOW 同时受限时按 Vixie 标准取「或」；按注入的 IANA 时区计算墙钟，
  自动跳过 DST 空洞，并对搜索步数设上限（`MAX_CANDIDATES`）防止非法表达式退化为无界循环。
- **任务定义存储**（`src/scheduler/store.ts`）：`<workspace>/.agent-base/tasks/<id>.json`，
  支持 `scheduler.tasksDir` 覆盖（仅相对 workspace，拒绝绝对路径与 `..` 越界）；
  id 单段文件名白名单防目录穿越；同目录临时文件 + `rename` 原子写；
  损坏文件、结构非法文件、文件内 `id` 与文件名骨架不一致的文件统一跳过并 warn。
- **运行状态存储**（`src/scheduler/state.ts`）：`<workspace>/.agent-base/state/scheduler.json`
  持久化连续失败次数、首次 / 最近失败时刻、最近失败分类与原因、最近成功时刻与
  24h 通知窗口；时间统一为带偏移的 ISO 8601；状态文件损坏 / 版本不符时降级为空状态。
- **文本渲染**（`src/scheduler/text.ts`）：7 个占位符 `{{date}}` / `{{time}}` /
  `{{datetime}}` / `{{iso}}` / `{{weekday}}` / `{{timezone}}` / `{{task_id}}`；
  按配置时区墙钟展开，`{{iso}}` 带真实偏移；单次替换不递归；按字素簇截断到
  `maxDeliverChars`；一行摘要派生（≤120 字素）。
- **任务程序校验**（`src/scheduler/validate.ts`）：L1 形态校验（非空、无 NUL / C0
  控制字符、扩展名白名单 `.js` / `.mjs` / `.cjs` / `.ts`）与 L2 文件校验
  （存在、普通文件、可读）；创建期强校验 + 触发期兜底，失败按 `runtime` / `missing` 分类。
- **任务执行器**（`src/scheduler/runner.ts`）：以 `node <task_path>` 起独立子进程，
  cwd 为程序所在目录；默认 60s 超时，`SIGTERM` 后 500ms 补 `SIGKILL`；
  stdout / stderr 按 UTF-8 字节有界收集（stdout 超限截断并强杀，stderr 仅截断用于诊断），截断点不切开多字节字符；
  解析 stdout 最后一个非空行为 `{"shouldWake":boolean,"data"?:string}`。
- **失败处理**（`src/scheduler/failure.ts`）：`missing` / `runtime` / `exec` / `parse` /
  `deliver` 五类失败；结构化失败通知文案；每任务 24h 至多一条通知；
  通知投递成功才消耗窗口；成功只清零失败计数（保留 24h 通知窗口），不发「已恢复」消息。
- **投递层**（`src/scheduler/deliver.ts`）：目标解析（自定义 session 不可达回退 main
  并记录 `fallbackFrom`）、内存 outbox（TTL、每任务条数上限、`agent/created` 自动补投）、
  同消息去重、失败通知不可达时改投 main 一次。
- **调度服务**（`src/scheduler/service.ts`）：`start` / `stop` / `reload`；
  每任务一条链式 timer；同任务单飞锁（定时触发与 `task_run_now` 共用）；代际守卫
  防止旧触发结算覆盖新代际状态；`setTimeout` 上限截断与提前唤醒重装；
  `lastOutcome` / `status` / `scheduledIds` 诊断查询。
- **任务编排**（`src/scheduler/task.ts`）：文本 / 脚本两条执行分支，统一产出
  `quiet` / `woke` / `queued` / `skipped` / `failed` 五种运行结局（类型层另含
  outbox 过期的 `missed` 诊断态）；投递成功后才开始 `cooldown_ms` 冷却；
  空文本静默完成并记为成功。
- **8 个任务工具**（`src/scheduler/tools.ts`）：`task_create` / `task_list` /
  `task_get` / `task_update` / `task_delete` / `task_enable` / `task_disable` /
  `task_run_now`；写操作成功后立即 `reload()`；`task_delete` 不删除任务程序文件。
- **配置与装配**（`src/config.ts` / `src/scheduler/mount.ts`）：新增 `scheduler`
  子配置及 11 个字段的默认值；`enabled=false` 时不注册工具、不创建 timer、不发布服务；
  `tasksDir` 非法时降级默认目录；工具注册失败回滚；装配失败只 warn，不阻断插件启动。
- **诊断与手动触发服务**：`ctx.agentScheduler`（`scheduledIds` / `isRunning` /
  `lastOutcome` / `status` 为只读查询，`reload` / `runNow` 为两个显式操作——`runNow` 会真实执行
  并投递、`reload` 会重读磁盘任务定义），不暴露 store / state / timer。
- **main session 启动准备**（`src/ensure-main.ts`）：`ensureMain(ctx, { timeoutMs })`
  在 `apply` 发布 `ctx.agentBase` 后**后台**执行，复用 live / `resume` / `create` 三态；
  内置 single-flight、canonical cwd 守卫、already-exists 回读、handle `ctx.effect` 释放；
  `agentOptions` 强制来自 `agentDefaultModel.currentSelection()`，preset 恒用宿主默认；
  超时只 warn 并在后台继续，失败永不 reject。
- **配置**：新增 `ensureTimeoutMs`（默认 `10000`，最小 `1`）。
- **测试**：调度子系统单元测试、`ensureMain` 状态机测试与装配级集成测试，全量 441 个测试通过。

### Changed

- **main session 准备延后到宿主加载完成**：`apply` 不再立即 `void ensureMain(...)`，改为
  同步调度 `scheduleEnsureAfterBoot`，等 Cordis loader 全部 entry 加载完成
  （`loader.await()`）后再后台准备 main session，避免与宿主插件（如 `tool-jobs`）的
  controller attach 竞争；loader 缺失 / 抛错时仍会继续准备，apply 本身始终不阻塞。
- `package.json` 版本 `0.1.0` → `0.2.0`。
- **bundle patch 内置 `logger-console`**：`cordis.patch.yml` 的 `insert` 列表新增
  `@deepseek-ai/cordis-plugin-logger-console`（`levels.default: 3`），并与
  `@deepseek-ai/cordis-plugin-logger-console` 建立 `~1.0.4` 运行时依赖。
  安装本插件即输出 INFO / WARN / ERROR / DEBUG 日志，无需再改 profile；profile 已有同 id 行时
  按 id 覆盖、不重复输出，仍可用 `disabled: true` 或同 id 配置覆盖默认值。
- `Config` 新增可选 `scheduler` 子配置；缺省时使用 `DEFAULT_SCHEDULER_CONFIG`。
- 插件 `apply` 在发布 `ctx.agentBase` 后装配调度子系统；`ctx.agentBase` 的
  `workspaceCwd` / `mainSessionId` 契约与只读语义不变，调度器从它读取默认投递目标。
- `apply` 在发布服务后以 `void ensureMain(...)` 后台准备 main session（不 await）；
  插件 `inject` 增加 `agentPresets` / `agentDefaultModel`。
- **调度器对「main 从未 provisioned」明确失败**：目标为 main、agent 未 live 且
  `sessionPersistence.stat` 无快照时，`DeliveryResult` 返回 `'failed'`，不进入 outbox；
  任务结局为 `failed / deliver`（detail: `main session 未 provisioned`）。
  有快照但离线仍按 `deliverOnOffline` 入队（瞬态）。
- README 新增「定时任务（scheduler）」章节，覆盖配置、任务格式、占位符、校验、
  结局、失败通知、`allowCustomSession`、工具与诊断服务；原文中「不投递消息」的表述
  修正为「核心不投递，调度子系统可向已 live 会话投递」。
- 新增调度子系统内部模块出口（`src/scheduler/index.ts`，覆盖 cron / store / state / text /
  validate / runner / failure / deliver / task / service / tools / agent-service / mount）；
  本次在包根仅新增 `mountScheduler` 与 `AgentSchedulerService` 两个调度入口（`DEFAULT_SCHEDULER_CONFIG` /
  `resolveSchedulerConfig` / `resolveSystemTimezone` 为配置解析辅助）；`package.json` 的 `exports` 未新增
  `./scheduler` 子路径，`parseCron` / `TaskStore` 等不对包外消费者开放。

### Fixed

- main session 从未成功创建时不再静默进入 outbox 并永远等不到补投：投递直接返回
  `failed` 并 warn「目标 main session 未 provisioned（任务 X）」，便于定位启动期准备失败。

- 调度静默无日志：`mountScheduler` 启动成功后 info 记录任务目录、时区与
  「已排定 / 禁用 / 损坏」计数；任务目录不存在或为空时 warn；`enabled=false` 时记录
  「调度已禁用」；`rebuild()` 后 info 记录清单统计，每条任务排定 / 跳过写 debug；
  结局日志补齐 `reason`，`failed` 追加 `failureKind`，`failed` / `skipped` 使用 warn。
  `resolveMountLogger` 兼容「工厂返回对象 / 工厂返回函数 / `ctx.logger` 自身带方法」
  三种形态，全部不可用时 warn / error 回落 `console`，任何分支都不抛异常。
  诊断服务新增 `nextRunAt(id)`（`SchedulerService` 与 `ctx.agentScheduler` 同步透传）。
- 任务文件内 `id` 与文件名骨架不一致时统一视为损坏：`list()` 跳过，`get()` 返回
  `undefined`，避免同一 id 装出多份 timer 或状态归属错乱。
- `task_update` 仅改名 / 改 cron / 改 `enabled` 时不再因任务程序暂时缺失而失败，
  只有显式提供 `task_path` 或变更 `kind` 才重跑 L2 校验。
- 失败通知的 24h 窗口只在通知**投递成功**后消耗；投递失败（含 `skipped`）不记账，
  下一次失败继续尝试。
- outbox 超限（`overflow`）与同消息去重（`dedupe`）不再回退 main，避免重复投递。
- `stop` / `reload` 后旧代际的在飞任务晚结算时不再覆盖新代际的 `lastOutcome`。
- 状态文件损坏、状态写入失败、通知窗口判断异常均降级处理，不阻断调度。
- 任务写入失败时清理临时文件不掩盖原始错误，统一收敛为 `TaskStoreError`。

### Known limitations

- cron 仅支持 5 段、最小粒度分钟；不支持秒字段、`@yearly` 等宏、`L` / `W` / `#` 扩展语法。
- DST 秋季回拨产生的**重复墙钟小时**只触发第一次，第二段（回拨后的同一本地小时）会被整段跳过；
  DST 春季空洞中不存在的墙钟时刻同样跳过。
- 对外导出的下一触发时刻函数名为 `nextCronTime`（内部模块名 `next`），
  消费方应使用别名，避免与其它调度库的 `next` 混淆。
- outbox 仅在内存中，进程重启即丢失；仅在目标会话 `agent/created` 时自动补投，
  没有持久化队列或跨进程补投。
- 自定义 `session_id` 只在目标 agent 已 live 时生效；未 live 会回退 main，
  不会为自定义目标排队。
- 没有错过触发的补跑（backfill）：进程停机期间错过的 cron 时刻不会在启动后重放。
- 无跨进程 / 跨实例互斥；多个插件实例指向同一 workspace 时会各自调度同一批任务。
- `script` 任务只使用 Node 运行时；`.ts` 依赖当前 Node 版本的类型擦除能力，
  不保证在所有 Node 版本上可直接执行。
- `pnpm typecheck`（`typecheck = typecheck:src && typecheck:examples`）只覆盖 `src/**` 与
  `examples/**`；`tests/**` 的类型错误由 vitest 运行时暴露，不在 `typecheck` 阶段拦截。
