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

当前版本（0.1.0）已实现**固定 workspace 的解析与注册**：启动时按 `config.workspace`
校验绝对路径 → `mkdir -p`（可选）→ `realpath` → `workspaceRegistry.create(canonical)`，
并把 `{ workspace, workspaceCwd, mainSessionId }` 存入包内状态（供后续任务发布
`ctx.agentBase` service）。仍未实现：`ctx.agentBase` service 发布、main session
创建/恢复、`validateExistingMain` 校验。

### 启动序列

```text
apply()
  ├─ 校验 config.workspace 为非空绝对路径（相对路径直接拒绝）
  ├─ createWorkspaceDir !== false → mkdir -p
  ├─ canonical = realpath(workspace)
  ├─ workspace = await workspaceRegistry.create(canonical)
  └─ 保存 { workspace, workspaceCwd: workspace.path, mainSessionId }
```

固定目录只有一个来源：**插件配置**。不从进程 cwd、registry 首项或任何已有
session 推断；失败时错误类型为 `AgentBaseConfigError`，信息中包含配置原值。

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
