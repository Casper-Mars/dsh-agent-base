/**
 * 资源搬运脚本：把 `tsc` 不会产出的资源带进 `dist-server/`。
 *
 * 本包无 `src/**` Markdown 资源，只把仓库根的 `cordis.patch.yml` 复制到
 * `dist-server/cordis.patch.yml`，保证产物目录自包含（bundle 校验与离线分发
 * 均可直接读取）。
 *
 * 写入方式：读源 → 写唯一临时文件 → 原子 rename 覆盖目标，幂等且并发安全。
 *
 * 用法：`node scripts/copy-assets.mjs`（由 `build` / `build:server` 调用）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'dist-server')

/** 幂等写入：读源 → 写唯一临时文件 → 原子 rename 覆盖目标。 */
function copyAssetIdempotent(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  const content = readFileSync(from)
  const tmp = `${to}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, to)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore cleanup failure */
    }
    throw err
  }
}

mkdirSync(outDir, { recursive: true })

let count = 0
const patch = path.join(root, 'cordis.patch.yml')
if (existsSync(patch)) {
  const to = path.join(outDir, 'cordis.patch.yml')
  copyAssetIdempotent(patch, to)
  console.log(`[dsh-agent-base-assets] cordis.patch.yml -> ${path.relative(root, to)}`)
  count += 1
} else {
  console.warn('[dsh-agent-base-assets] cordis.patch.yml 不存在，跳过')
}

console.log(`[dsh-agent-base-assets] 共搬运 ${count} 个资源文件到 dist-server/`)
