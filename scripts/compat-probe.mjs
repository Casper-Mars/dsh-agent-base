/**
 * 运行时兼容探针：在**真的装上本包**的 dsh profile 上冷启动一次，断言
 * `ctx.agentBase` 已发布、main session id 正确、调度工具已注册。
 * `dsh --dump-config` 只证明 patch 能组合，不证明插件 `apply()` 能跑通；
 * 服务契约或模块解析变更会在冷启动时暴露。
 *
 * 用法（由 dsh-compat.sh 调用，必须从 dsh 安装目录运行，裸导入才能解析）：
 *
 *   DSH_HOME=<临时目录> PROBE_PROFILE=web node compat-probe.mjs
 *
 * 退出码：全 PASS 为 0，任一断言失败为 1，启动失败 / 超时为 1。
 *
 * 本文件同时可被静态检查导入，因此顶层不得有副作用：只有直接执行时才跑探针主体。
 */
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 90_000

async function main() {
  const profile = process.env.PROBE_PROFILE ?? 'web'
  const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const failures = []

  const pass = (message) => console.log(`PASS ${message}`)
  const fail = (message) => {
    failures.push(message)
    console.log(`FAIL ${message}`)
  }

  const timer = setTimeout(() => {
    console.error(`FAIL 冷启动超时（${timeoutMs}ms）：profile "${profile}" 未在限定时间内完成挂载`)
    process.exit(1)
  }, timeoutMs)

  const { runProfile } = await import('@deepseek-ai/dsh/lib/profile-boot.js')
  const { createLaunchEnvironmentSnapshot } = await import('@deepseek-ai/dsh-launch-environment')
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])

  let ctx
  let shutdown
  try {
    const patchFiles = process.env.PROBE_PATCH ? [process.env.PROBE_PATCH] : []
    ;({ ctx, shutdown } = await runProfile({ environment, profile, patchFiles, args: ['--no-open'] }))
  } catch (error) {
    clearTimeout(timer)
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`FAIL profile "${profile}" 冷启动失败：${detail}`)
    process.exit(1)
  }

  try {
    const base = ctx.get('agentBase')
    if (base === undefined || typeof base.workspaceCwd !== 'string' || typeof base.mainSessionId !== 'string') {
      fail('ctx.agentBase 缺失或字段不完整：AgentBaseService 契约可能已变更')
    } else if (base.mainSessionId !== 'main') {
      fail(`ctx.agentBase.mainSessionId 是 "${base.mainSessionId}"，期望 "main"`)
    } else {
      pass(`ctx.agentBase 已发布：workspaceCwd=${base.workspaceCwd}, mainSessionId=${base.mainSessionId}`)
    }

    const scheduler = ctx.get('agentScheduler')
    if (scheduler === undefined || !Array.isArray(scheduler.scheduledIds)) {
      fail('ctx.agentScheduler 缺失或 scheduledIds 不是数组：调度服务契约可能已变更')
    } else {
      pass(`ctx.agentScheduler 已发布：已排定 ${scheduler.scheduledIds.length} 个任务`)
    }
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    fail(`探针断言抛错：${detail}`)
  } finally {
    clearTimeout(timer)
    try {
      await shutdown?.shutdown(failures.length === 0 ? 0 : 1)
    } catch {
      // 关停失败不覆盖断言结论
    }
  }

  if (failures.length > 0) {
    console.error(`\n兼容探针失败：${failures.length} 项断言未通过`)
    process.exit(1)
  }
  console.log('\n运行时探针全部通过')
  process.exit(0)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
