# dsh-agent-base

固定 Workspace 与 main session id 的 dsh 插件包。核心是**身份与路径的权威来源**。
workspace 生命周期会在 `apply()` 之后**后台准备 main session**（复用 live / `resume` / `create`，
不阻塞插件启动）。0.2.0 起内置定时调度子系统，可向会话投递任务结果与失败通知；
目标未 live 时进入内存 outbox 或按配置跳过（见「[定时任务（scheduler）](#定时任务scheduler)」）。

> **适用范围：仅 web profile。** 本包通过 bundle patch 禁用 `directory-picker`，
> web 组合里存在该行，其他 profile 没有；装到别的 profile 会报找不到该行。

## 它做什么

- 禁用 `directory-picker`（`@deepseek-ai/dsh-host-directory-picker-auto`）：
  directory-flow 槽位没有 occupant 后，`Add workspace` 按钮和快捷键入口自动消失，
  workspace picker 里也不再出现「添加工作区」。这是 dsh 官方支持的组合级关闭方式。
- 插入 `agent-base` 插件行（`inject: workspaceRegistry / sessionPersistence / agents / agentPresets / agentDefaultModel`）。
- 0.2.0 起在插件 `apply` 中装配定时调度器：从 workspace 读取任务定义、按 cron
  触发、通过 8 个 `task_*` 工具管理，并发布诊断与手动触发服务 `ctx.agentScheduler`。

当前版本（0.2.0）在**固定 workspace 的解析、注册、已有 main session 校验与只读服务发布**
之上新增**定时调度子系统**：任务定义存于 workspace，按 5 段 cron 触发；支持 text 与
script 两类任务、失败通知、离线补投与 8 个 `task_*` 工具。main session 的创建 / 恢复
由启动期的后台 `ensureMain` 负责，调度器本身仍然不创建、不恢复会话。

启动时按 `config.workspace` 校验绝对路径 → `mkdir -p`（可选）→ `realpath` →
`workspaceRegistry.create(canonical)` → 校验同 id 的 main session 的 cwd 是否与之一致 →
发布只读的 `ctx.agentBase` service → **后台准备 main session（不 await）** → 装配调度子系统。

### 启动序列

```text
apply()
  ├─ 校验 config.workspace 为非空绝对路径（相对路径直接拒绝）
  ├─ createWorkspaceDir !== false → mkdir -p
  ├─ canonical = realpath(workspace)
  ├─ workspace = await workspaceRegistry.create(canonical)
  ├─ validateExistingMain({ mainSessionId, workspaceCwd: workspace.path, validateExistingMain })
  │    ├─ 开关为 false → 跳过（连 agents.get 都不调用）
  │    ├─ agents.get(mainSessionId) 命中 → 比较 header.cwd（不再查持久化）
  │    ├─ 未命中 → sessionPersistence.stat(mainSessionId)
  │    │    ├─ undefined → 无该 session，通过
  │    │    └─ 有快照 → 比较 header.cwd
  │    └─ cwd 不一致 → AgentBaseWorkspaceMismatchError
  ├─ new AgentBaseService(ctx, { workspaceCwd: workspace.path, mainSessionId })
  ├─ void ensureMain(ctx, { timeoutMs: config.ensureTimeoutMs })   // 后台，不 await
  │    ├─ agents.get(mainSessionId) 命中 → 复用 live Agent
  │    ├─ 有快照 → canonical cwd 校验 → agents.resume(...)
  │    └─ 无快照 → agents.create(...) → workspace.attachSession(mainSessionId)
  └─ mountScheduler(...)
```

校验严格在 service 实例化**之前**完成：失败时不会留下已注册的 `ctx.agentBase`。

固定目录只有一个来源：**插件配置**。不从进程 cwd、registry 首项或任何已有
session 推断；失败时错误类型为 `AgentBaseConfigError`，信息中包含配置原值。

### 校验已有 main session 的 cwd

`validateExistingMain` 是**只读守卫**：它只回答「若 main session 已存在，它是否在
固定 workspace 里」，不修复、不改投。

- 不调用 `agents.create` / `agents.resume`；
- 不调用 `workspace.attachSession`；
- 不修改 session header（不改 cwd、不改绑 workspace）；
- session 不存在时直接通过，**不**顺手创建。

cwd 比较是 canonical 比较：字符串相等直接通过，否则对实际值 `realpath` 后比较；
`realpath` 失败（路径已不存在）视为不匹配。因此历史 session 里的 symlink 拼写
不会误报。

错误模型（`src/errors.ts`，均继承 `AgentBaseError`）：

| 类型 | 触发条件 | 结构化字段 |
| --- | --- | --- |
| `AgentBaseConfigError` | workspace 配置/目录准备失败 | `workspace`（配置原值） |
| `AgentBaseWorkspaceMismatchError` | main session 的 cwd 与固定 workspace 不一致 | `mainSessionId` / `expectedCwd` / `actualCwd`（可能为 `undefined`） |
| `AgentBaseValidationError` | 校验无法完成（例如 `stat` 抛错） | `mainSessionId` / `cause`（原始错误） |

`AgentBaseWorkspaceMismatchError.message` 同时包含实际路径与期望路径（无 cwd 时显示
`<none>`），便于直接从启动日志定位。

### 服务契约

`apply` 成功后可在真实 Cordis `Context` 上读取 `ctx.agentBase`：

```ts
interface AgentBaseService {
  readonly workspaceCwd: string
  readonly mainSessionId: SessionId
}
```

实际读取就是这两个属性：

```ts
const cwd = ctx.agentBase.workspaceCwd
const id = ctx.agentBase.mainSessionId
```

- 两个值在构造后不可变（属性不可写、不可重配置）；
- **没有** `ensure` / `deliver` / `bind` / `status`；
- 服务本身不创建/恢复 Agent，main 的准备由 `apply` 的后台生命周期完成，且不通过该服务暴露；
- 消费方自行决定消息的 followup / steer。

### 失败模式

| 场景 | 结果 |
| --- | --- |
| `config.workspace` 为空/相对路径/不可访问 | 启动失败，`AgentBaseConfigError`（message 含配置原值） |
| live 或 persisted main session 的 cwd 与固定 workspace 不一致 | 启动失败，`AgentBaseWorkspaceMismatchError`（message 含 actual 与 expected） |
| `sessionPersistence.stat` 抛错 | 启动失败，`AgentBaseValidationError`（`cause` 为原始错误） |
| 没有任何 main session | 启动通过；后台准备 main（`created`），失败只 warn，不阻断启动 |

任何情况下都不会「静默改投」到别的 workspace，也不会把已有 session 改绑到固定 workspace。

### 关于默认 `/workspace`

`cordis.patch.yml` 中的默认 `workspace: /workspace` 面向**容器部署**（容器内根目录可写，
部署仓会挂载该路径）。在本机直接 boot 时 `/workspace` 通常不存在且根目录只读，
启动会报错——这是部署契约而非插件缺陷。本机验证请用 profile patch 覆盖：

```yaml
- id: agent-base
  config:
    workspace: /tmp/dsh-agent-base-ws
    mainSessionId: main
    createWorkspaceDir: true
    validateExistingMain: true
```

注意：profile 层的 `config` 是**整体替换**而非深合并，覆盖时必须显式写 `workspace`
与 `mainSessionId` 两个必填字段，否则会报缺失（例如 `mainSessionId missing required value`）。
`createWorkspaceDir` / `validateExistingMain` / `ensureTimeoutMs` 有默认值，可省略；
但整体替换时建议显式写全，以免误读。

## 构建

```bash
pnpm install
pnpm build
```

产物：

- `dist-server/index.js`
- `dist-server/types/index.d.ts`
- `dist-server/cordis.patch.yml`

## 安装到 web profile

> **本地路径安装不装依赖**：`dsh plugin add <本地路径>` 采用 link 方式，只把
> 本包链进 profile，**不会**把本包的 `dependencies` 装进 profile。因此本地安装前
> 必须先在仓库内完成 `pnpm install && pnpm build`——运行期 `logger-console`
> 等依赖解析到的是本仓库自己的 `node_modules`，仓库没装依赖就会缺包。
> 通过 npm 安装（`dsh plugin add dsh-agent-base`）时依赖由 registry 自动安装，
> 无需这一步。

```bash
# 本地路径安装：先在本仓库装依赖并构建
pnpm install && pnpm build

dsh plugin --profile web add /Users/reachlucifer/project/opc/dsh-agent-base
# 或发布后（依赖自动安装）：dsh plugin --profile web add dsh-agent-base
```

安装后由 `@deepseek-ai/dsh-plugin-manager` 自动把 `dsh-agent-base` 写入
profile `package.json` 的 `dsh.profile.bundles`，无需手工编辑
`$DSH_HOME/profiles/web/cordis.patch.yml`。

安装后**自动启用 `logger-console`**（`@deepseek-ai/cordis-plugin-logger-console`
`~1.0.x`，peer 要求 `@deepseek-ai/cordis ~4.0.5`，与本包 peer 一致；
`levels.default: 3` = DEBUG 阈值），**INFO / WARN / ERROR / DEBUG 均输出到终端**
（DEBUG 含逐任务排定明细），不需要再改 profile 就能看到启动与调度日志。该行按 id
分层覆盖：profile 已有同 id 行时以 profile 为准、不会重复输出；如需自定义格式或关闭，
在 profile 的 `cordis.patch.yml` 写一行同 id 配置或 `disabled: true`。

## 卸载

```bash
dsh plugin --profile web remove dsh-agent-base
```

卸载后 bundle patch 一并移除，`directory-picker` 恢复启用。

## 配置

```yaml
- id: agent-base
  name: 'dsh-agent-base'
  config:
    workspace: /workspace
    mainSessionId: main
    createWorkspaceDir: true
    validateExistingMain: true
    ensureTimeoutMs: 10000
```

| 字段 | 说明 |
| --- | --- |
| `workspace` | 必填，固定工作区绝对路径（相对路径启动失败）；不存在时按 `createWorkspaceDir` 创建 |
| `mainSessionId` | 必填且非空，稳定 id，`[A-Za-z0-9._-]{1,64}` |
| `createWorkspaceDir` | 目录不存在时是否创建，默认 `true` |
| `validateExistingMain` | 已有同 id 会话的 cwd 不一致时是否启动失败，默认 `true` |
| `ensureTimeoutMs` | 启动期后台准备 main session 的等待上限（毫秒，默认 `10000`，最小 `1`）；超时只 warn，准备继续在后台进行 |
| `scheduler` | 可选，定时调度子配置；整体省略时全部取默认值（`enabled=true`），字段见「[定时任务（scheduler）](#定时任务scheduler)」 |

`validateExistingMain: false` 会**完全跳过启动期校验**（该校验自身不再调用 `agents.get` / `stat`），
已有 session 的 cwd 不一致也不会阻止启动。注意：后台 `ensureMain` 仍会独立执行只读探测与准备。
仅建议用于一次性排障，不建议用于生产：它会让 session 与固定 workspace 不一致的脏状态静默通过。

### main session 启动准备

`apply()` 发布 `ctx.agentBase` 后，立即以 `void ensureMain(ctx, { timeoutMs: config.ensureTimeoutMs })`
在**后台**准备 main session。它不 await、不阻塞插件启动，也不影响 `mountScheduler`：

```text
agents.get(mainSessionId) 命中 → 复用 live Agent
sessionPersistence.stat(mainSessionId)
  ├─ 有快照 → canonical cwd 校验 → agents.resume({ resumeSessionId, agentOptions, setup })
  └─ 无快照 → agents.create({ sessionId, meta: { cwd: workspaceCwd, agentPreset }, agentOptions, setup })
              → workspaceRegistry.create(workspaceCwd).attachSession(mainSessionId)
```

固定语义：

- preset 恒用宿主默认（`agentPresets.resolve(undefined)`），模型恒用 `agentDefaultModel.currentSelection()`；
  `agentOptions` 必传，缺失服务时按可读错误降级；
- **single-flight**：同一 `Context` + session 的并发准备只跑一次；
- **cwd 守卫**：`resume` 前做 canonical 比较，不一致直接拒绝，绝不把会话投到错误 workspace；
- **already exists 竞态**：`create` 抛 already exists 时回读 `agents.get`，命中则复用；
- 新建成功后 `attachSession` 进固定 workspace；失败则 dispose 刚创建的 handle；
- handle 通过 `ctx.effect` 随插件 fiber 卸载释放；
- `ensureTimeoutMs` 到点只写 `main session 准备超时（…ms），转入后台`，准备流程继续；
- 成功日志：`main session 已就绪（created|resumed）`；失败日志：`main session 准备失败：<原因>`。

后台准备失败**不会**让 `apply` 失败；受影响的只是「main 从未 provisioned」时的任务投递（见下文）。

## 定时任务（scheduler）

0.2.0 起，`agent-base` 内置一个**文件驱动**的定时调度器：

- 任务定义是 workspace 里的 JSON 文件（`<workspace>/.agent-base/tasks/<id>.json`），可直接编辑、备份、迁移；
- 调度器按 5 段 cron（分 时 日 月 周）触发，最小粒度分钟；
- 任务分两类：`text`（到点渲染文本并投递）与 `script`（跑一个 Node 程序，读 stdout 末行 JSON 决定是否投递）；
- 只向会话投递；目标未 live 时按 `deliverOnOffline` 入内存 outbox 或跳过；
  main 从未 provisioned 时返回 `failed`（不排队）；
- 通过 8 个 `task_*` 工具做增删改查与立即执行，另发布诊断与手动触发服务 `ctx.agentScheduler`。

目录布局：

```text
<workspace>/
├── .agent-base/
│   ├── tasks/                 # 任务定义（可由 scheduler.tasksDir 覆盖）
│   │   └── daily-report.json
│   └── state/
│       └── scheduler.json     # 失败计数与 24h 通知窗口（运行时自动维护）
└── scripts/
    └── daily-report.mjs       # 任务程序（script 任务）
```

> 调度器**不创建 / 不恢复会话**。它只复用 `ctx.agents` 里已 live 的 agent 投递消息；
> main 的准备由 workspace 启动阶段的后台 `ensureMain` 负责。若 main 从未 provisioned
> （`sessionPersistence.stat` 无快照），投递返回 `failed`，任务结局为 `failed / deliver`，不进入 outbox。

### 最小可用配置

只需要固定 workspace 与 main session id；`scheduler` 整体省略时全部取默认值（`enabled=true`）：

```yaml
- id: agent-base
  config:
    workspace: /workspace
    mainSessionId: main
```

此时调度器已启用，默认从 `<workspace>/.agent-base/tasks/` 读取任务，使用进程系统时区（取不到回落 `UTC`），默认主会话为 `main`。

### 完整配置示例

```yaml
- id: agent-base
  config:
    workspace: /workspace
    mainSessionId: main
    createWorkspaceDir: true
    validateExistingMain: true
    scheduler:
      enabled: true
      timezone: Asia/Shanghai
      tasksDir: .agent-base/tasks
      allowScript: true
      allowCustomSession: false
      scriptTimeoutMs: 60000
      maxOutputBytes: 1048576
      maxDeliverChars: 4000
      deliverOnOffline: queue
      pendingTtlMs: 600000
      maxPendingPerTask: 20
```

#### scheduler 字段与默认值

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用调度子系统 |
| `timezone` | string | 系统时区，取不到回落 `UTC` | cron 计算与占位符渲染使用的 IANA 时区 |
| `tasksDir` | string | `.agent-base/tasks` | 任务定义目录，**相对 workspace** |
| `allowScript` | boolean | `true` | 是否允许创建 / 执行 script 任务 |
| `allowCustomSession` | boolean | `false` | 是否允许工具入参写 `session_id`（仅影响工具 schema 与写入） |
| `scriptTimeoutMs` | number | `60000` | script 执行超时（毫秒） |
| `maxOutputBytes` | number | `1048576`（1 MiB） | script stdout / stderr 单路上限（字节） |
| `maxDeliverChars` | number | `4000` | 投递正文预算（字素） |
| `deliverOnOffline` | string | `queue` | 目标未 live 时的行为：`queue` 入内存 outbox，`skip` 直接跳过 |
| `pendingTtlMs` | number | `600000`（10 分钟） | outbox 条目 TTL（毫秒） |
| `maxPendingPerTask` | number | `20` | 每任务离线队列合计上限 |

`enabled=false` 的效果：mount 阶段直接返回——不注册任何 `task_*` 工具、不创建定时器、不发布 `ctx.agentScheduler`。已有任务文件不受影响，但不会被执行。这是「临时停掉整个调度」的开关；只想停单个任务请改任务文件里的 `enabled` 或调用 `task_disable`。

> ⚠️ **profile 层 `config` 是整体替换，不是深合并**。在 profile patch 里覆盖时必须显式写全 `workspace` 与 `mainSessionId` 两个必填字段，否则缺失字段会直接报错（例如 `mainSessionId missing required value`）；`createWorkspaceDir` / `validateExistingMain` 有默认值，可省略。`scheduler` 可以整体省略（全部取默认值）；若写了，未写的子字段按 schema 的字段级默认补齐。

### 任务定义

默认路径 `<workspace>/.agent-base/tasks/<id>.json`。`id` 必须与文件名骨架一致（`daily-report.json` 里的 `id` 必须是 `daily-report`）；不一致、JSON 损坏或结构非法的文件会被跳过并记 warn，不阻断其它任务。

`scheduler.tasksDir` 可覆盖目录，但**只接受相对 workspace 的路径**；绝对路径或 `..` 越界的配置会被拒绝并降级回默认目录 `.agent-base/tasks`（启动时 warn）。

公共字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 任务唯一标识；`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`，不得含路径分隔符 |
| `name` | 是 | 人类可读名称（非空） |
| `cron` | 是 | 严格 5 段：分 时 日 月 周；支持 `*`、`?`（仅日 / 周）、`5`、`1,2`、`9-17`、`*/15`、`9-17/2` 与英文月 / 周缩写；周日可用 `0` 或 `7` |
| `enabled` | 是 | `false` 时不参与调度（仍可被 `task_run_now` 手动执行） |
| `session_id` | 否 | 自定义投递目标；缺省投 `mainSessionId` |
| `cooldown_ms` | 否 | 投递冷却（0–3600000，缺省 0），只在**投递成功后**计时 |

> `cooldown_ms` 目前只能手工编辑任务文件设置（8 个工具的入参未暴露该字段）；代码重写任务
> （`task_update` / `task_enable` / `task_disable`）时会保留磁盘上已有的该字段。

`kind` 是判别字段，缺省 `script`：

| `kind` | 必填字段 | 禁止字段 |
| --- | --- | --- |
| `script`（或省略） | `task_path`（非空，相对 workspace 或绝对路径） | `text` |
| `text` | `text`（字符串，允许空串） | `task_path` |

#### script 任务示例

`<workspace>/.agent-base/tasks/daily-report.json`：

```json
{
  "id": "daily-report",
  "name": "每日构建报告",
  "cron": "0 9 * * *",
  "enabled": true,
  "task_path": "scripts/daily-report.mjs"
}
```

`<workspace>/scripts/daily-report.mjs`：

```js
// 随便输出诊断信息；只有 stdout 的最后一个非空行会被解析。
console.log('collecting build status...')

const failed = process.env.BUILD_FAILED === '1'
if (!failed) {
  // 静默完成：不投递任何消息。
  console.log(JSON.stringify({ shouldWake: false }))
} else {
  // 需要投递：data 会作为正文（投递前按字素预算截断）。
  console.log(JSON.stringify({ shouldWake: true, data: '今日构建失败，请查看流水线。' }))
}
```

script 返回契约：

- 程序以 `node <task_path>` 在**独立子进程**中执行，cwd 是任务程序所在目录（便于向上解析 `node_modules`）；
- 只读取 stdout 的**最后一个非空行**，必须是 JSON 对象；
- `{"shouldWake": true, "data": "..."}` → 投递 `data`；
- `{"shouldWake": false}` → 静默完成（算成功，会清失败链）；
- 其余情况（无输出、末行非 JSON、`shouldWake` 非 boolean、`shouldWake:true` 但 `data` 非 string）→ `failed / parse`；
- 非零退出、崩溃、超时、stdout 超限 → `failed / exec`；进程启动失败 → `failed / runtime`。

#### text 任务示例

```json
{
  "id": "standup-reminder",
  "name": "站会提醒",
  "kind": "text",
  "cron": "30 9 * * 1-5",
  "enabled": true,
  "session_id": "team-room",
  "cooldown_ms": 60000,
  "text": "现在是 {{datetime}}（{{timezone}}），请同步今日进展。"
}
```

文本任务到点后：按配置时区展开占位符 → 按 `maxDeliverChars` 字素截断 → 投递。**渲染后 trim 为空**视为「无需通知」：返回 `quiet`，仍记为成功执行（清失败链），不投递空消息。

> 任务文件里的 `session_id` 是运行期字段，手工编辑即可生效，不受 `allowCustomSession` 限制（该开关只影响工具入参，见下文）。

### 文本占位符

| 占位符 | 示例（`Asia/Shanghai`） | 说明 |
| --- | --- | --- |
| `{{date}}` | `2026-11-06` | 配置时区的日期 |
| `{{time}}` | `09:30` | 配置时区的时分（24 小时制） |
| `{{datetime}}` | `2026-11-06 09:30` | 日期 + 时分 |
| `{{iso}}` | `2026-11-06T09:30:00+08:00` | 带真实时区偏移的 ISO 8601（秒精度） |
| `{{weekday}}` | `周五` | 中文星期 |
| `{{timezone}}` | `Asia/Shanghai` | 配置里的时区名 |
| `{{task_id}}` | `standup-reminder` | 当前任务 id |

规则：

- 一律按 `scheduler.timezone` 的**墙钟**计算，不是进程本地时区；`{{iso}}` 带该时刻的真实偏移（跨夏令时也正确）；
- **单次替换**：占位符的值里即使出现 `{{...}}` 也不会再次展开（无递归注入）；
- 未知占位符**原样保留**（写错时能一眼看出来，不会被静默吞掉）；
- 先展开，再按 `maxDeliverChars`（默认 4000）**字素簇**截断——不会切开 emoji / ZWJ 组合。

### 任务程序校验

`script` 任务的 `task_path` 分两层校验：

| 层 | 检查内容 | 失败分类 |
| --- | --- | --- |
| L1 形态 | 非空字符串；不含 NUL / C0 控制字符 / DEL；扩展名属于 `.js` / `.mjs` / `.cjs` / `.ts`（大小写不敏感） | `runtime` |
| L2 文件 | 存在、普通文件、可读（`R_OK`） | `missing` |

- **创建期强校验**：`task_create` 与 `task_update`（新增 / 替换 script 程序时）在落盘前跑完 L1 + L2，明显写错的路径直接报错；
- **触发期兜底**：每次执行前再校验一次，文件在任务创建后被删除 / 改权限会得到 `failed`（并触发失败通知），而不是静默不跑；
- `task_update` 只在**显式提供 `task_path`** 或 **`kind` 变更**时重跑 L2；仅改名 / 改 cron / 改 `enabled` 时保留旧路径（程序文件可能等待部署，改名不应硬失败），此时 `task_get` 的非破坏性 warnings 会提示程序不可用；
- 不做语法解析（语法错误交给 Node 自己报），也不限制目录归属（`task_path` 允许相对 workspace 或绝对路径）。

### 运行、冷却与投递

任务执行与投递的结局取以下六种之一（`task_run_now` 的输出 schema 同口径；`missed` 是 outbox 过期的诊断态，schema 中保留该判别分支作向前兼容，但当前不会由执行返回；过期条目在下次入队或目标上线补投时被惰性丢弃并记日志）：

| 结局 | 含义 |
| --- | --- |
| `quiet` | 执行成功但无需投递（`shouldWake:false` / 文本为空） |
| `woke` | 目标 live，消息已投递 |
| `queued` | 目标未 live，消息进入内存 outbox（有限补投） |
| `skipped` | 主动跳过：冷却中、单飞锁被占用、投递被 `skip` 策略丢弃、outbox 超限 |
| `failed` | 失败，附 `failureKind`（见下节） |
| `missed` | outbox 条目过期：在下次入队或目标上线补投时惰性丢弃并记日志，不再补发；无后台周期清理与持久化计数；不作为一次执行结局返回 |

关键语义：

- **单飞**：同一任务同一时刻只跑一次。定时触发与 `task_run_now` 共用一把锁；锁被占用时本次直接 `skipped`，不排队；
- **不阻塞下一轮**：执行在后台结算，下一次 cron 到点仍会照常触发；
- **冷却**：`cooldown_ms` 只在**投递成功后**开始计时（`delivered` / `queued` 都算投递成功）；冷却期内触发返回 `skipped`；
- **离线补投**：`deliverOnOffline: queue`（默认）把消息放进内存 outbox，目标会话上线（`agent/created`）时按入队顺序补投；`skip` 则直接丢弃并返回 `skipped`；
- **main 未 provisioned 不排队**：目标为 main 且 `sessionPersistence.stat` 无快照（从未创建成功）时，返回 `failed` 且不入 outbox；只有「有快照但暂时离线」才按 `deliverOnOffline` 处理；
- outbox 只在内存中，**进程重启即丢失**；每条消息有 `pendingTtlMs` TTL，每任务最多 `maxPendingPerTask` 条，超限不再入队；
- `task_run_now` 立即执行一次，不影响既有 cron 计时，也不检查 `enabled`（可用来手动跑一个已禁用的任务）。

### 失败通知

失败分五类：

| `failureKind` | 触发场景 |
| --- | --- |
| `missing` | 任务定义文件不存在；任务程序不存在 / 不是普通文件 / 不可读 |
| `runtime` | 扩展名不在白名单；`allowScript=false`；Node 进程启动失败（运行时不可用） |
| `exec` | 非零退出、崩溃、超时、stdout 超限 |
| `parse` | stdout 末行不是合法结果 JSON |
| `deliver` | 投递异常（例如目标解析失败）；目标 main 从未 provisioned |

通知策略：

- **每任务 24 小时内至多一条失败通知**（窗口闭区间：距上次通知恰好 24h 即可再次通知）；
- 通知投递成功才把窗口起点记为**本次失败时刻**；投递失败不消耗窗口，下一次失败会继续尝试；
- **成功不发「已恢复」**：任务成功只清零连续失败计数与失败链字段，**保留最近通知时刻**（24h 上限不因成功而重置），不产生任何消息；
- 失败状态落盘 `<workspace>/.agent-base/state/scheduler.json`（含连续失败次数、首次 / 最近失败时刻、最近分类与原因）；重启不清零；
- 状态文件损坏 / 版本不符时降级为空状态并 warn，不阻断调度；
- 连续失败次数与通知窗口是两件事：24h 内的后续失败仍会累加计数，只是不再发通知。

失败通知示例：

```text
【定时任务失败】每日构建报告（daily-report）
类型：script
阶段：结果解析失败（stdout 末行不是合法结果 JSON）
原因：期望 {"shouldWake":boolean,"data"?:string}
连续失败：3 次（首次 2026-11-06T09:00:00+08:00 / 最近 2026-11-08T09:00:00+08:00）
下次最早通知：2026-11-09T09:00:00+08:00
任务定义：.agent-base/tasks/daily-report.json
任务程序：/workspace/scripts/daily-report.mjs
```

失败通知的目标解析与普通投递一致；自定义目标不可达时，通知会**改投 main 一次**（并记录 `fallbackFrom`）。

### allowCustomSession

默认 `false`。它**只控制工具入参**：

- `false` 时，`task_create` / `task_update` 的 parameters 里没有 `session_id`，且 `additionalProperties: false` 会直接拒绝传入；
- `true` 时，允许在工具入参里写 `session_id`，创建 / 更新时只做形态校验（非空字符串），**不检查会话是否存在**（允许先建任务、后建会话）。

它**不影响运行期**：任务文件里已经存在的 `session_id`（例如手工编辑或历史任务）无论开关取值都会在触发时生效；`task_update` / `task_enable` / `task_disable` 的整文件重写也会保留磁盘上已有的 `session_id`，不会因为关闭开关而抹掉。

运行期目标解析：

1. `session_id` 为空 / 未写 → 投 `mainSessionId`；
2. `session_id` 对应的 agent **live** → 投它；
3. 不 live（或无法确认）→ **回退 `mainSessionId`**，并在结局里记录 `fallbackFrom`（原目标 id）。注意：自定义目标未 live 时不会为它排队，而是直接投 main；main 有快照但未 live 时按 `deliverOnOffline` 入 outbox / 跳过；main 从未 provisioned 时返回 `failed`。

`allowCustomSession` 建议保持 `false`，只在确实需要多会话分流时打开，并确保目标会话由消费方负责保持 live。

### 工具清单

8 个工具（`enabled=false` 时全部不注册）：

| 工具 | 作用 |
| --- | --- |
| `task_create` | 新建任务；`id` 必须唯一，不允许覆盖已有任务 |
| `task_list` | 列出全部任务（按 id 升序），附带损坏文件诊断；只读 |
| `task_get` | 读取单条任务（含非破坏性 warnings）；只读 |
| `task_update` | 更新已有任务；未提供的字段保持原值；`id` 不存在时报错（不会新建） |
| `task_delete` | 删除任务定义；**不删除**任务程序文件 |
| `task_enable` | 仅把 `enabled` 改为 `true`，保留其它字段 |
| `task_disable` | 仅把 `enabled` 改为 `false`，保留其它字段与定义 |
| `task_run_now` | 立即执行一次并返回运行结局（不含仅作诊断态的 `missed`，见「运行、冷却与投递」）；不影响 cron 计时 |

所有写操作成功后立即 `reload()`，新定义马上生效，无需重启。

### 诊断服务

调度启用时发布诊断与手动触发服务 `ctx.agentScheduler`（查询只读，另有两个显式操作 `reload` / `runNow`）：

```ts
ctx.agentScheduler.scheduledIds       // 已排定的任务 id（升序快照）
ctx.agentScheduler.nextRunAt(id)      // 下次触发时刻（未排定 undefined）
ctx.agentScheduler.isRunning(id)      // 是否有在飞执行（单飞锁）
ctx.agentScheduler.lastOutcome(id)    // 最近一次结局（含 skipped）
ctx.agentScheduler.status(id)         // 失败状态（连续失败 / 窗口）
ctx.agentScheduler.reload()           // 重新加载任务清单
ctx.agentScheduler.runNow(id)         // 立即执行一次
```

`runNow(id)` 会**真实执行任务并向目标会话投递消息**，`reload()` 会重读磁盘上的任务定义；两者都不是纯读操作。

除这两个显式入口外不暴露 store / state / timer，也不提供创建 / 修改 / 删除入口——写能力只属于 8 个 `task_*` 工具。

### 故障排查

启动与运行日志使用固定关键字，排查时先在宿主日志里搜索：

| 关键字 | 含义 |
| --- | --- |
| `调度器已启动：任务目录=…，时区=…，已排定 N 个任务` | 启动成功；N 为实际装上 timer 的任务数 |
| `任务清单加载完成：共 …，启用 …，禁用 …，损坏 …` | 每次 `start` / `reload` 的清单统计 |
| `任务 <id> 已排定：下次触发 <ISO8601>（cron=…）` | debug 级；逐任务确认下次触发时刻 |
| `任务 <id> 已禁用，跳过调度` | debug 级；任务 `enabled=false` |
| `任务 <id> 结局：<kind> — <reason>` | 每次执行结局；`failed` 追加 `failureKind=<kind>` |
| `任务目录不存在：…` / `任务目录为空：…` / `任务目录不是目录：…` / `任务目录不可访问：…` | 目录缺失、没有任何任务、路径被普通文件占用或 stat 失败：调度器仍正常启动，但不会有可调度任务 |
| `调度已禁用（scheduler.enabled=false）` | 配置关闭了调度子系统 |

| 现象 | 排查方向 |
| --- | --- |
| 完全没有调度日志 | 先搜 `调度器已启动` / `任务清单加载完成`；若都没有，说明 `ctx.logger` 不是可识别的形态（此时 warn / error 会走 `console` 兜底） |
| 完全没有任何日志输出 | 本包已内置 `logger-console`，正常情况下装完即有日志。若仍无输出：① 检查 profile 的 `cordis.patch.yml` 是否把 `logger-console` 行 `disabled: true` 关掉了，或覆盖成不含 INFO 的 `levels`；② 检查宿主是否把 stdout / stderr 重定向到文件或 `/dev/null`（`dsh ... > /dev/null 2>&1`、systemd / docker 的日志驱动等）；③ 确认终端 `TERM` / `NO_COLOR` 未导致输出异常 |
| 任务不触发 | `task_get` 看 `enabled` / `cron`；`ctx.agentScheduler.scheduledIds` 是否包含该 id；`nextRunAt(id)` 是否为 `undefined`；cron 是否 5 段且合法 |
| 日志提示任务目录不存在 / 为空 / 不是目录 / 不可访问 | 创建 `<workspace>/.agent-base/tasks/`，或用 `task_create` 新建任务；若该路径被普通文件占用则先移走；不可访问时检查目录权限（需可读 + 可执行） |
| 改了 JSON 没生效 | 运行中的调度器不监听文件变化；用 `task_update` 或调用 `reload()` 重新加载 |
| script 一直 `missing` | `task_path` 相对 workspace 解析；确认文件存在、是普通文件、进程可读 |
| script `parse` 失败 | stdout 最后一个非空行必须是 `{"shouldWake":...}` JSON；诊断日志不要放在最后一行 |
| 消息没收到 | 目标是否 live；`queued` 表示在内存 outbox，会话上线才补投；重启会丢 outbox |
| 失败没通知 | 24h 窗口未到期（看 `ctx.agentScheduler.status(id).nextNotifyAt`）；通知投递失败不消耗窗口，会重试 |

## 消费方接入

调度之外，本包为消费方发布 `ctx.agentBase` 的两个只读值（`workspaceCwd` / `mainSessionId`），
并在启动期**后台准备 main session**；调度启用时另有诊断与手动触发服务 `ctx.agentScheduler`（见上节）。
**base 仍然不替消费方投递**：消息的 source / 幂等键、`followup` 还是 `steer` 由消费方决定。
main 的准备逻辑已作为正式模块导出（`ensureMain`），消费方可直接复用其 single-flight 与 cwd 守卫。

### 读取顺序：显式 session 优先

```ts
// 调用方指定了 session 就直接用，不要读 agentBase。
const sessionId = explicitSessionId ?? ctx.agentBase.mainSessionId
```

`ctx.agentBase` 只服务「没有指定 session」的场景（后台派单、定时任务、webhook 转投等）。
显式 session 的 cwd、preset、生命周期由调用方自己负责。

### main session 准备（`ensureMain`）

内置实现见 `src/ensure-main.ts`，并从包入口导出 `ensureMain` / `DEFAULT_ENSURE_TIMEOUT_MS`。
它负责「保证 `ctx.agentBase.mainSessionId` 有一个 live Agent」：

```text
ctx.agents.get(mainSessionId) 命中 → 复用 live Agent
ctx.sessionPersistence.stat(mainSessionId)
  ├─ 有快照：canonical 校验 header.cwd（realpath 归一）→ ctx.agents.resume({ resumeSessionId, agentOptions, setup })
  └─ 无快照：ctx.agents.create({ sessionId, meta: { cwd: workspaceCwd, agentPreset }, agentOptions, setup })
            → workspaceRegistry.create(workspaceCwd).attachSession(mainSessionId)
```

| 场景 | 行为 |
| --- | --- |
| main 已在 live registry | 直接复用，不 resume、不 create、不 stat |
| 有持久化快照 | 先按 canonical 路径校验 `header.cwd`，再 `resume`（必须带 `agentOptions`） |
| 无持久化快照 | `create` 时把 `meta.cwd` 固定为 `workspaceCwd`，随后 `attachSession` 进固定 workspace |
| 并发调用 | single-flight 合并为一次 |
| 超时 | `ensureTimeoutMs` 到点只 warn，后台继续 |

[`examples/ensure-main.ts`](./examples/ensure-main.ts) 仍然保留，作为**消费方投递链路**的完整示例
（自定义消息 `source` / 幂等键 / `followup`）；其中的 ensure 仅是演示，正式实现以本包导出为准。
示例自身的类型检查：

```bash
pnpm typecheck:examples   # examples/**/*.ts，独立 tsconfig.examples.json，noEmit
```

### 由消费方决定、base 不提供的能力

- **source / deliveryId**：消息来源与幂等键由消费方声明。示例通过合并扩展
  `MessageSourceMap` 定义自己的 `kind`，base 不认识也不校验任何来源；
- **followup 还是 steer**：示例用 `followup` 排一个独立 turn；要插入当前 step 请改用 `agent.steer(...)`；
- **显式 session**：调用方给出 `sessionId` 时完全不读 `ctx.agentBase`，其 cwd / preset / 生命周期由调用方自己负责。

示例自身的类型检查：

```bash
pnpm typecheck:examples   # examples/**/*.ts，独立 tsconfig.examples.json，noEmit
```

## Patch 分层说明

bundle patch 叠加在 `@deepseek-ai/dsh-web-app` 之后，因此 `directory-picker` 行
一定已存在。上层 profile 仍可覆盖：

```yaml
- id: directory-picker
  disabled: false
```

即重新打开添加工作区能力——这是 dsh 的 patch 分层语义，插件本身不锁定该行为。

## 验证（不污染真实 profile）

```bash
TMPHOME=$(mktemp -d)
mkdir -p "$TMPHOME/profiles"
cp -R ~/.dsh/profiles/web "$TMPHOME/profiles/web"
DSH_HOME="$TMPHOME" dsh plugin --profile web add "$PWD"

# 本机验证：覆盖默认 /workspace 为可写临时目录
cat >> "$TMPHOME/profiles/web/cordis.patch.yml" <<'YAML'
- id: agent-base
  config:
    workspace: /tmp/dsh-agent-base-ws-it
    mainSessionId: main
    createWorkspaceDir: true
    validateExistingMain: true
YAML

DSH_HOME="$TMPHOME" dsh --profile web --dump-config | grep -A4 -E 'id: agent-base|id: directory-picker'
timeout 12 env DSH_HOME="$TMPHOME" dsh --profile web --no-open   # 观察启动日志

DSH_HOME="$TMPHOME" dsh plugin --profile web remove dsh-agent-base
rm -rf "$TMPHOME" /tmp/dsh-agent-base-ws-it
```
