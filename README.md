# dsh-agent-base

固定 Workspace 与 main session id 的 dsh 插件包。它是**身份与路径的权威来源**，
不是投递总线：不创建 Agent、不投递消息、不提供 `deliver/ensure`。

> **适用范围：仅 web profile。** 本包通过 bundle patch 禁用 `directory-picker`，
> web 组合里存在该行，其他 profile 没有；装到别的 profile 会报找不到该行。

## 它做什么

- 禁用 `directory-picker`（`@deepseek-ai/dsh-host-directory-picker-auto`）：
  directory-flow 槽位没有 occupant 后，`Add workspace` 按钮和快捷键入口自动消失，
  workspace picker 里也不再出现「添加工作区」。这是 dsh 官方支持的组合级关闭方式。
- 插入 `agent-base` 插件行（`inject: workspaceRegistry / sessionPersistence / agents`），
  后续任务将在此发布 `ctx.agentBase = { workspaceCwd, mainSessionId }`。

当前版本（0.1.0）仅包含骨架：`apply` 为空实现，无任何文件系统或会话副作用。

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
| `workspace` | 必填，固定工作区绝对路径 |
| `mainSessionId` | 必填，稳定 id，建议 `[A-Za-z0-9._-]{1,64}` |
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
DSH_HOME="$TMPHOME" dsh --profile web --dump-config | grep -A3 -E 'id: agent-base|id: directory-picker'
DSH_HOME="$TMPHOME" dsh plugin --profile web remove dsh-agent-base
```
