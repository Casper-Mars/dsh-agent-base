# dsh-agent-base

固定 Workspace 与 main session id 的 dsh 插件包。它是**身份与路径的权威来源**，
不是投递总线：不创建 Agent、不投递消息、不提供 `deliver/ensure`。

> **适用范围：仅 web profile。** 本包通过 bundle patch 禁用 `directory-picker`，
> web 组合里存在该行，其他 profile 没有；装到别的 profile 会报找不到该行。

## 它做什么

- 禁用 `directory-picker`（`@deepseek-ai/dsh-host-directory-picker-auto`）：
  directory-flow 槽位没有 occupant 后，`Add workspace` 按钮和快捷键入口自动消失，
  workspace picker 里也不再出现「添加工作区」。这是 dsh 官方支持的组合级关闭方式。
- 插入 `agent-base` 插件行（`inject: workspaceRegistry / sessionPersistence / agents`）。

当前版本（0.1.0）已实现**固定 workspace 的解析、注册、已有 main session 校验与只读服务发布**：
启动时按 `config.workspace` 校验绝对路径 → `mkdir -p`（可选）→ `realpath` →
`workspaceRegistry.create(canonical)` → 校验同 id 的 main session 的 cwd 是否与之一致 →
发布只读的 `ctx.agentBase` service。仍未实现：main session 创建/恢复。

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
  └─ new AgentBaseService(ctx, { workspaceCwd: workspace.path, mainSessionId })
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
- 不创建/恢复 Agent，不调用 `workspace.attachSession`；
- 消费方自行创建/恢复 Agent，并自行决定 followup / steer。

### 失败模式

| 场景 | 结果 |
| --- | --- |
| `config.workspace` 为空/相对路径/不可访问 | 启动失败，`AgentBaseConfigError`（message 含配置原值） |
| live 或 persisted main session 的 cwd 与固定 workspace 不一致 | 启动失败，`AgentBaseWorkspaceMismatchError`（message 含 actual 与 expected） |
| `sessionPersistence.stat` 抛错 | 启动失败，`AgentBaseValidationError`（`cause` 为原始错误） |
| 没有任何 main session | 启动通过，**不**创建 session |

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

注意：profile 层的 `config` 是**整体替换**而非深合并，覆盖时必须写全四个字段，
否则未写字段会变成缺失（例如 `mainSessionId missing required value`）。

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

```bash
dsh plugin --profile web add /Users/reachlucifer/project/opc/dsh-agent-base
# 或发布后：dsh plugin --profile web add dsh-agent-base
```

安装后由 `@deepseek-ai/dsh-plugin-manager` 自动把 `dsh-agent-base` 写入
profile `package.json` 的 `dsh.profile.bundles`，无需手工编辑
`$DSH_HOME/profiles/web/cordis.patch.yml`。

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
```

| 字段 | 说明 |
| --- | --- |
| `workspace` | 必填，固定工作区绝对路径（相对路径启动失败）；不存在时按 `createWorkspaceDir` 创建 |
| `mainSessionId` | 必填且非空，稳定 id，`[A-Za-z0-9._-]{1,64}` |
| `createWorkspaceDir` | 目录不存在时是否创建，默认 `true` |
| `validateExistingMain` | 已有同 id 会话的 cwd 不一致时是否启动失败，默认 `true` |

`validateExistingMain: false` 会**完全跳过**校验（连 `agents.get` / `stat` 都不调用），
已有 session 的 cwd 不一致也不会阻止启动。仅建议用于一次性排障，不建议用于生产：
它会让 session 与固定 workspace 不一致的脏状态静默通过。

## 消费方接入

本包只发布 `ctx.agentBase` 的两个只读值（`workspaceCwd` / `mainSessionId`）。
**base 不创建 main、不投递、不提供 `ensure`**：首个 main Agent、消息的 source 与
幂等键、并发保护、`followup` 还是 `steer`，全部由消费方自己决定。

### 读取顺序：显式 session 优先

```ts
// 调用方指定了 session 就直接用，不要读 agentBase。
const sessionId = explicitSessionId ?? ctx.agentBase.mainSessionId
```

`ctx.agentBase` 只服务「没有指定 session」的场景（后台派单、定时任务、webhook 转投等）。
显式 session 的 cwd、preset、生命周期由调用方自己负责。

### `ensureMain` 参考实现

完整可复制示例见 [`examples/ensure-main.ts`](./examples/ensure-main.ts)
（**示例，不是本包导出**：未在 `package.json` 的 `exports` / `files` 中，也不进 `dist-server`）。
它演示的链路：

```text
显式 sessionId ? 用显式值（不读 agentBase） : 读 ctx.agentBase
  → ctx.agents.get(mainSessionId) 命中 → 复用 live Agent
  → 未命中：ctx.sessionPersistence.stat(mainSessionId)
      ├─ 有快照：canonical 校验 header.cwd（realpath 归一）→ ctx.agents.resume({ resumeSessionId, agentOptions, setup })
      └─ 无快照：ctx.agents.create({ sessionId, meta: { cwd: workspaceCwd, agentPreset }, agentOptions, setup })
                → workspaceRegistry.create(workspaceCwd).attachSession(mainSessionId)
  → agent.followup(createUserMessage({ content, source: { kind, deliveryId, ... } }))
```

| 场景 | 参考实现的行为 |
| --- | --- |
| main 已在 live registry | 直接复用，不 resume、不 create |
| 有持久化快照 | 先按 canonical 路径校验 `header.cwd`（字符串不等时 `realpath` 归一），再 `resume`（**必须带 `agentOptions`**，否则恢复出的 Agent 没有模型） |
| 无持久化快照 | `create` 时把 `meta.cwd` 固定为 `workspaceCwd`，随后 `attachSession` 进固定 workspace |
| 调用方给了显式 session | 只走显式分支，完全不读 `ctx.agentBase`；不存在时由调用方决定重建 |

### 由消费方决定、base 不提供的能力

- **single-flight**：并发首次投递要在消费方做（示例用 `WeakMap<Context, Map<SessionId, Promise>>`
  缓存进行中的 ensure，**main 与显式 session 两条路径共用**），否则并发的 `create` / `resume`
  会有一个收到 already exists；
- **source / deliveryId**：消息来源与幂等键由消费方声明。示例通过合并扩展
  `MessageSourceMap` 定义自己的 `kind`，base 不认识也不校验任何来源；
- **followup 还是 steer**：示例用 `followup` 排一个独立 turn；要插入当前 step 请改用 `agent.steer(...)`；
- **handle 释放**：`create` / `resume` 返回的 `AgentHandle` 由调用方持有，示例用
  `ctx.effect(() => () => handle.dispose())` 随插件 fiber 卸载释放；释放后再投递会走 `resume`，不会重复建会话。

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
