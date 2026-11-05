/**
 * 任务工具层**缺口补充**测试（任务-06）。
 *
 * 与 `scheduler-tools.spec.ts` 互补，重点覆盖：
 *   - 字段合并矩阵：未提供字段逐一保留（含 cooldown_ms / session_id）；
 *   - script ↔ text 转换后**落盘 JSON** 的专属字段清除（而非仅视图裁剪）；
 *   - session_id 形态校验边界（空串 / 空白 / 非字符串 / 任意字符集）；
 *   - allowScript=false 下的读取 / 删除 / text 更新；
 *   - task_run_now 六态原样返回与 output.schema 一致性；
 *   - ToolDefinition 真实契约（dsh-tools 的 schema 子集校验 + execute 异步）；
 *   - onChange 失败路径与「写失败不触发」。
 *
 * 全部使用 tmp 目录真实文件；不写用户目录、不起子进程、不真实 sleep。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createTaskStore, resolveTasksDir } from '../src/scheduler/store.js'
import { SCHEDULER_TOOL_NAMES, createSchedulerTools } from '../src/scheduler/tools.js'
import type { SchedulerToolsOptions } from '../src/scheduler/tools.js'
import type { TaskStore } from '../src/scheduler/store.js'
import type { TaskDef, TaskRunOutcome } from '../src/scheduler/types.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

interface Fixture {
  readonly root: string
  readonly workspace: string
  readonly tasksDir: string
  readonly store: TaskStore
  readonly scriptPath: string
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tools-gap-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'programs'), { recursive: true })
  const tasksDir = resolveTasksDir(workspace)
  mkdirSync(tasksDir, { recursive: true })
  const scriptPath = join(workspace, 'programs', 'hello.ts')
  writeFileSync(scriptPath, 'console.log(JSON.stringify({ shouldWake: false }))\n', 'utf8')
  return { root, workspace, tasksDir, store: createTaskStore({ tasksDir }), scriptPath }
}

function makeTools(fixture: Fixture, overrides: Partial<SchedulerToolsOptions> = {}): ToolDefinition[] {
  return createSchedulerTools({
    store: fixture.store,
    workspace: fixture.workspace,
    ...overrides,
  })
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`未找到工具 ${name}`)
  return found
}

async function call(
  tools: ToolDefinition[],
  name: string,
  args: unknown,
): Promise<unknown> {
  const definition = tool(tools, name)
  const value = await definition.execute(args, {} as never)
  // 用 dsh-tools 官方校验器核对出参（比手写子集更接近真实注册链路）。
  const violations = validateJsonSchemaValue(definition.output.schema as never, value as never)
  expect(violations).toEqual([])
  const blocks = definition.output.render(args as never, value as never)
  expect(Array.isArray(blocks)).toBe(true)
  expect(blocks.length).toBeGreaterThan(0)
  for (const block of blocks) {
    expect((block as { type?: string }).type).toBe('text')
    expect(typeof (block as { text?: unknown }).text).toBe('string')
  }
  return value
}

/** 读取落盘 JSON（断言专属字段是否真的被清除）。 */
function readTaskFile(fixture: Fixture, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixture.tasksDir, `${id}.json`), 'utf8')) as Record<string, unknown>
}

const RICH_SCRIPT: TaskDef = {
  id: 'rich-script',
  name: '富脚本任务',
  cron: '15 3 * * 1',
  enabled: true,
  task_path: 'programs/hello.ts',
  session_id: 'ou_rich_session',
  cooldown_ms: 900_000,
}

const RICH_TEXT: TaskDef = {
  id: 'rich-text',
  name: '富文本任务',
  cron: '30 7 * * *',
  enabled: false,
  kind: 'text',
  text: '原始正文',
  session_id: 'ou_text_session',
  cooldown_ms: 120_000,
}

// ---------------------------------------------------------------------------
// task_update 字段合并矩阵
// ---------------------------------------------------------------------------

describe('task_update 字段合并矩阵', () => {
  it('只改 name：script 的 cron / task_path / enabled / session_id / cooldown_ms 全保留', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture, { allowCustomSession: false })

    await call(tools, 'task_update', { id: RICH_SCRIPT.id, name: '改名后' })

    const disk = readTaskFile(fixture, RICH_SCRIPT.id)
    expect(disk.name).toBe('改名后')
    expect(disk.cron).toBe(RICH_SCRIPT.cron)
    expect(disk.task_path).toBe('programs/hello.ts')
    expect(disk.enabled).toBe(true)
    expect(disk.session_id).toBe('ou_rich_session')
    expect(disk.cooldown_ms).toBe(900_000)
    expect(disk.kind === undefined || disk.kind === 'script').toBe(true)
    expect('text' in disk).toBe(false)
  })

  it('只改 name：text 的 kind / text / cron / enabled / session_id / cooldown_ms 全保留', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const tools = makeTools(fixture, { allowCustomSession: false })

    await call(tools, 'task_update', { id: RICH_TEXT.id, name: '文本改名' })

    const disk = readTaskFile(fixture, RICH_TEXT.id)
    expect(disk).toMatchObject({
      id: RICH_TEXT.id,
      name: '文本改名',
      cron: RICH_TEXT.cron,
      enabled: false,
      kind: 'text',
      text: '原始正文',
      session_id: 'ou_text_session',
      cooldown_ms: 120_000,
    })
    expect('task_path' in disk).toBe(false)
  })

  it('未传 kind：script 任务不会退化成 text，也不会丢 task_path', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture)

    const value = (await call(tools, 'task_update', { id: RICH_SCRIPT.id, cron: '0 4 * * *' })) as {
      task: Record<string, unknown>
    }
    expect(value.task.kind).toBe('script')
    expect(value.task.task_path).toBe('programs/hello.ts')
    expect(value.task).not.toHaveProperty('text')
    expect(readTaskFile(fixture, RICH_SCRIPT.id).kind === undefined || readTaskFile(fixture, RICH_SCRIPT.id).kind === 'script').toBe(true)
  })

  it('只改 enabled：其它字段（含 session_id / cooldown_ms）不变', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture)

    await call(tools, 'task_update', { id: RICH_SCRIPT.id, enabled: false })

    expect(readTaskFile(fixture, RICH_SCRIPT.id)).toMatchObject({
      name: RICH_SCRIPT.name,
      cron: RICH_SCRIPT.cron,
      task_path: 'programs/hello.ts',
      enabled: false,
      session_id: 'ou_rich_session',
      cooldown_ms: 900_000,
    })
  })

  it('script → text：落盘 JSON 中 task_path 真正消失，公共字段保留', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture)

    await call(tools, 'task_update', {
      id: RICH_SCRIPT.id,
      kind: 'text',
      text: '转换后的正文',
    })

    const disk = readTaskFile(fixture, RICH_SCRIPT.id)
    expect('task_path' in disk).toBe(false)
    expect(disk).toMatchObject({
      kind: 'text',
      text: '转换后的正文',
      name: RICH_SCRIPT.name,
      cron: RICH_SCRIPT.cron,
      enabled: true,
      session_id: 'ou_rich_session',
      cooldown_ms: 900_000,
    })
  })

  it('text → script：落盘 JSON 中 text 真正消失，公共字段保留', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const tools = makeTools(fixture)

    await call(tools, 'task_update', {
      id: RICH_TEXT.id,
      kind: 'script',
      task_path: 'programs/hello.ts',
    })

    const disk = readTaskFile(fixture, RICH_TEXT.id)
    expect('text' in disk).toBe(false)
    expect(disk.kind === undefined || disk.kind === 'script').toBe(true)
    expect(disk).toMatchObject({
      task_path: 'programs/hello.ts',
      name: RICH_TEXT.name,
      cron: RICH_TEXT.cron,
      enabled: false,
      session_id: 'ou_text_session',
      cooldown_ms: 120_000,
    })
  })
})

// ---------------------------------------------------------------------------
// create 缺省值 / cooldown
// ---------------------------------------------------------------------------

describe('task_create 缺省值与参数面', () => {
  it('enabled 缺省 true，显式 false 生效', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)

    const first = (await call(tools, 'task_create', {
      id: 'default-on',
      name: '默认启用',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
    })) as { task: { enabled: boolean } }
    expect(first.task.enabled).toBe(true)
    expect(readTaskFile(fixture, 'default-on').enabled).toBe(true)

    const second = (await call(tools, 'task_create', {
      id: 'explicit-off',
      name: '显式禁用',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
      enabled: false,
    })) as { task: { enabled: boolean } }
    expect(second.task.enabled).toBe(false)
  })

  it('enabled 非 boolean 被拒，且不落盘', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    for (const enabled of [1, 'true', null]) {
      await expect(
        call(tools, 'task_create', {
          id: 'bad-enabled',
          name: 'x',
          cron: '0 9 * * *',
          task_path: 'programs/hello.ts',
          enabled,
        }),
      ).rejects.toThrow(/enabled 必须是 boolean/)
    }
    expect(fixture.store.get('bad-enabled')).toBeUndefined()
  })

  it('create / update 的 parameters 不暴露 cooldown_ms，传了会被 additionalProperties:false 拒绝', () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    for (const name of ['task_create', 'task_update']) {
      const definition = tool(tools, name)
      const properties = definition.parameters.properties as Record<string, unknown>
      expect(properties).not.toHaveProperty('cooldown_ms')
      const violations = validateJsonSchemaValue(definition.parameters as never, {
        id: 'x',
        name: 'x',
        cron: '0 9 * * *',
        task_path: 'programs/hello.ts',
        cooldown_ms: 3_600_001,
      } as never)
      expect(violations.join('\n')).toMatch(/cooldown_ms.*not a declared property/)
    }
  })

  it('text 允许空串正文', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    const value = (await call(tools, 'task_create', {
      id: 'empty-text',
      name: '空文本',
      cron: '0 9 * * *',
      kind: 'text',
      text: '',
    })) as { task: { text: string } }
    expect(value.task.text).toBe('')
    expect(readTaskFile(fixture, 'empty-text').text).toBe('')
  })
})

// ---------------------------------------------------------------------------
// session_id 形态边界
// ---------------------------------------------------------------------------

describe('session_id 形态边界', () => {
  it('allowCustomSession=true：空串 / 纯空白 / 非字符串均被拒', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, { allowCustomSession: true })
    for (const [index, sessionId] of ['', '   ', 0, null, true, {}].entries()) {
      await expect(
        call(tools, 'task_create', {
          id: `bad-session-${index}`,
          name: 'x',
          cron: '0 9 * * *',
          task_path: 'programs/hello.ts',
          session_id: sessionId,
        }),
      ).rejects.toThrow(/session_id 必须是非空字符串/)
      expect(fixture.store.get(`bad-session-${index}`)).toBeUndefined()
    }
  })

  it('allowCustomSession=true：不限制字符集 / 长度，原样接受任意非空字符串', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, { allowCustomSession: true })
    const exotic = `会话 id !@#$%^&*() []{} 中文 \t-._${'x'.repeat(300)}`
    const value = (await call(tools, 'task_create', {
      id: 'exotic-session',
      name: '怪异会话',
      cron: '0 9 * * *',
      kind: 'text',
      text: 'hi',
      session_id: exotic,
    })) as { task: { session_id: string } }
    expect(value.task.session_id).toBe(exotic)
    expect(readTaskFile(fixture, 'exotic-session').session_id).toBe(exotic)
  })

  it('allowCustomSession=true：update 可设置 / 覆盖 session_id，未传则保留', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, { allowCustomSession: true })
    await call(tools, 'task_create', {
      id: 'session-swap',
      name: '会话',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
    })
    await call(tools, 'task_update', { id: 'session-swap', session_id: 'ou_first' })
    expect(readTaskFile(fixture, 'session-swap').session_id).toBe('ou_first')

    await call(tools, 'task_update', { id: 'session-swap', session_id: 'ou_second' })
    expect(readTaskFile(fixture, 'session-swap').session_id).toBe('ou_second')

    await call(tools, 'task_update', { id: 'session-swap', name: '改名' })
    expect(readTaskFile(fixture, 'session-swap').session_id).toBe('ou_second')
  })

  it('allowCustomSession=false：text 任务改名 / enable / disable 后磁盘 session_id 仍在', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const tools = makeTools(fixture, { allowCustomSession: false })

    await call(tools, 'task_update', { id: RICH_TEXT.id, name: '文本改名2' })
    expect(readTaskFile(fixture, RICH_TEXT.id).session_id).toBe('ou_text_session')

    await call(tools, 'task_enable', { id: RICH_TEXT.id })
    expect(readTaskFile(fixture, RICH_TEXT.id)).toMatchObject({ enabled: true, session_id: 'ou_text_session' })

    await call(tools, 'task_disable', { id: RICH_TEXT.id })
    expect(readTaskFile(fixture, RICH_TEXT.id)).toMatchObject({ enabled: false, session_id: 'ou_text_session' })
  })

  it('allowCustomSession=false：直接 execute 传 session_id 一律拒绝（create / update）', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const tools = makeTools(fixture, { allowCustomSession: false })
    await expect(
      call(tools, 'task_update', { id: RICH_TEXT.id, session_id: 'ou_new' }),
    ).rejects.toThrow(/allowCustomSession=false/)
    expect(readTaskFile(fixture, RICH_TEXT.id).session_id).toBe('ou_text_session')
  })
})

// ---------------------------------------------------------------------------
// update 的 kind 交叉约束
// ---------------------------------------------------------------------------

describe('task_update 的 kind 交叉约束', () => {
  it('script 任务未传 kind 却传 text：拒绝且磁盘不变', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture)
    const before = readTaskFile(fixture, RICH_SCRIPT.id)

    await expect(
      call(tools, 'task_update', { id: RICH_SCRIPT.id, text: '不该出现' }),
    ).rejects.toThrow(/script 任务不得提供 text/)
    expect(readTaskFile(fixture, RICH_SCRIPT.id)).toEqual(before)
  })

  it('script → text 未传 text：拒绝', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_update', { id: RICH_SCRIPT.id, kind: 'text' }),
    ).rejects.toThrow(/text 任务必须提供 text/)
  })

  it('text → script 未传 task_path：拒绝', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_update', { id: RICH_TEXT.id, kind: 'script' }),
    ).rejects.toThrow(/必须提供 task_path/)
  })

  it('text 任务未传 kind 却传 task_path：拒绝且磁盘不变', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const tools = makeTools(fixture)
    const before = readTaskFile(fixture, RICH_TEXT.id)
    await expect(
      call(tools, 'task_update', { id: RICH_TEXT.id, task_path: 'programs/hello.ts' }),
    ).rejects.toThrow(/text 任务不得提供 task_path/)
    expect(readTaskFile(fixture, RICH_TEXT.id)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// cron 边界
// ---------------------------------------------------------------------------

describe('cron 边界', () => {
  it('非法字符被拒且错误可读', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_create', {
        id: 'cron-char',
        name: 'x',
        cron: 'a * * * *',
        task_path: 'programs/hello.ts',
      }),
    ).rejects.toThrow(/不是整数/)
  })

  it('空串 / 纯空白 cron 被拒', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    for (const cron of ['', '   ']) {
      await expect(
        call(tools, 'task_create', { id: 'cron-empty', name: 'x', cron, task_path: 'programs/hello.ts' }),
      ).rejects.toThrow(/cron 必须是非空字符串/)
    }
  })

  it('update 非法 cron 被拒且磁盘原值不变', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_update', { id: RICH_SCRIPT.id, cron: '0 0 9 * * *' }),
    ).rejects.toThrow(/应含 5 段/)
    expect(readTaskFile(fixture, RICH_SCRIPT.id).cron).toBe(RICH_SCRIPT.cron)
  })

  it('update 越界 cron 被拒', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_update', { id: RICH_SCRIPT.id, cron: '* 24 * * *' }),
    ).rejects.toThrow(/超出范围 0-23/)
  })
})

// ---------------------------------------------------------------------------
// allowScript
// ---------------------------------------------------------------------------

describe('allowScript=false 的非写入路径', () => {
  it('task_list 仍返回已有 script 任务；task_delete 仍可删除', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture, { allowScript: false })

    const listed = (await call(tools, 'task_list', {})) as {
      tasks: Array<{ id: string; kind: string }>
    }
    expect(listed.tasks).toEqual([expect.objectContaining({ id: RICH_SCRIPT.id, kind: 'script' })])

    await call(tools, 'task_delete', { id: RICH_SCRIPT.id })
    expect(existsSync(join(fixture.tasksDir, `${RICH_SCRIPT.id}.json`))).toBe(false)
  })

  it('allowScript=false 仍可更新 text 任务', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const tools = makeTools(fixture, { allowScript: false })
    const value = (await call(tools, 'task_update', {
      id: RICH_TEXT.id,
      name: '文本仍可改',
      text: '新正文',
    })) as { task: { kind: string; text: string } }
    expect(value.task.kind).toBe('text')
    expect(value.task.text).toBe('新正文')
  })
})

// ---------------------------------------------------------------------------
// task_run_now 六态
// ---------------------------------------------------------------------------

const RUN_OUTCOMES: TaskRunOutcome[] = [
  { kind: 'quiet', reason: '无需投递' },
  { kind: 'woke', reason: '已投递', data: '正文', targets: ['ou_main'] },
  { kind: 'queued', reason: '目标离线，已入队', targets: ['ou_offline'], fallbackFrom: 'ou_custom' },
  { kind: 'skipped', reason: '冷却中', detail: '剩余 10s' },
  {
    kind: 'failed',
    reason: '程序不存在',
    detail: 'ENOENT',
    failureKind: 'missing',
    notified: true,
    consecutiveFailures: 3,
  },
  { kind: 'missed', reason: '离线消息过期', detail: 'outbox 丢弃' },
]

describe('task_run_now 六态', () => {
  it('六态结局均原样返回且通过 output.schema', async () => {
    for (const [index, outcome] of RUN_OUTCOMES.entries()) {
      const fixture = makeFixture()
      fixture.store.save({ ...RICH_SCRIPT })
      const tools = makeTools(fixture, { runNow: async () => outcome })
      const value = await call(tools, 'task_run_now', { id: RICH_SCRIPT.id })
      expect(value).toBe(outcome)
      expect(value).toEqual(RUN_OUTCOMES[index])
      // 不修改任务定义。
      expect(readTaskFile(fixture, RICH_SCRIPT.id)).toMatchObject({
        enabled: true,
        task_path: 'programs/hello.ts',
      })
    }
  })

  it('failed 结局的失败分类字段不被工具层改写', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const tools = makeTools(fixture, {
      runNow: async () => ({
        kind: 'failed',
        reason: '执行失败',
        detail: 'exit=1',
        failureKind: 'exec',
        notified: false,
        consecutiveFailures: 1,
      }),
    })
    const value = (await call(tools, 'task_run_now', { id: RICH_SCRIPT.id })) as Record<string, unknown>
    expect(value).toMatchObject({
      kind: 'failed',
      failureKind: 'exec',
      notified: false,
      consecutiveFailures: 1,
    })
  })

  it('任务不存在时报错且不调用 runNow', async () => {
    const fixture = makeFixture()
    const runNow = vi.fn(async () => ({ kind: 'quiet', reason: 'x' }) as TaskRunOutcome)
    const tools = makeTools(fixture, { runNow })
    await expect(call(tools, 'task_run_now', { id: 'ghost' })).rejects.toThrow(/不存在/)
    expect(runNow).not.toHaveBeenCalled()
  })

  it('runNow 未注入且任务不存在：先报任务不存在，不泄露执行能力缺失', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    await expect(call(tools, 'task_run_now', { id: 'ghost' })).rejects.toThrow(/任务 ghost 不存在/)
  })

  // 已知风险（latent，非当前验收阻断项）：TaskRunOutcome 的 missed 允许
  // `scheduledAt: Date`，而 output.schema 是 JSON Schema（无 Date 类型），
  // dsh-tools 的输出校验会以「must be a lossless JSON object」拒绝。
  // 当前调度实现尚未产出带 scheduledAt 的 missed，故用 it.fails 固化风险，
  // 一旦工具层改为序列化 ISO 字符串，本用例会转为失败以提示更新。
  it.fails('已知风险：missed 携带 Date 型 scheduledAt 时输出不是 lossless JSON', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    const missed: TaskRunOutcome = {
      kind: 'missed',
      reason: '离线消息过期',
      scheduledAt: new Date('2026-01-01T00:00:00Z'),
    }
    const tools = makeTools(fixture, { runNow: async () => missed })
    await call(tools, 'task_run_now', { id: RICH_SCRIPT.id })
  })

  it('run_now 不触发 onChange', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    let changes = 0
    const tools = makeTools(fixture, {
      onChange: () => void (changes += 1),
      runNow: async () => ({ kind: 'quiet', reason: 'x' }),
    })
    await call(tools, 'task_run_now', { id: RICH_SCRIPT.id })
    expect(changes).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ToolDefinition 契约（dsh-tools 真实校验器）
// ---------------------------------------------------------------------------

describe('ToolDefinition 契约', () => {
  it('8 个工具的 parameters / output.schema 均属于 dsh-tools 支持的 object schema 子集', () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    expect(tools.map((item) => item.name)).toEqual([...SCHEDULER_TOOL_NAMES])
    for (const item of tools) {
      expect(() => assertObjectJsonSchema(item.parameters as never)).not.toThrow()
      expect(() => assertObjectJsonSchema(item.output.schema as never)).not.toThrow()
    }
  })

  it('8 个工具的 execute 均为异步函数并返回 Promise', () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    for (const item of tools) {
      expect(item.execute.constructor.name).toBe('AsyncFunction')
    }
    // 只读工具直接调用，确认返回 Promise（不依赖内部 await 的实现细节）。
    const pending = tool(tools, 'task_list').execute({}, {} as never)
    expect(typeof (pending as Promise<unknown>).then).toBe('function')
    return pending.then(() => undefined)
  })

  it('parameters.required 矩阵符合契约', () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    const expected: Record<string, string[]> = {
      task_create: ['id', 'name', 'cron'],
      task_list: [],
      task_get: ['id'],
      task_update: ['id'],
      task_delete: ['id'],
      task_enable: ['id'],
      task_disable: ['id'],
      task_run_now: ['id'],
    }
    for (const [name, required] of Object.entries(expected)) {
      expect(tool(tools, name).parameters.required ?? []).toEqual(required)
      expect(tool(tools, name).parameters.additionalProperties).toBe(false)
    }
  })

  it('session_id 在关闭时被官方校验器拒绝，开启时通过', () => {
    const fixture = makeFixture()
    const args = {
      id: 'schema-session',
      name: 'x',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
      session_id: 'ou_x',
    }
    const off = makeTools(fixture, { allowCustomSession: false })
    for (const name of ['task_create', 'task_update']) {
      const violations = validateJsonSchemaValue(tool(off, name).parameters as never, args as never)
      expect(violations.join('\n')).toMatch(/session_id.*not a declared property/)
    }
    const on = makeTools(fixture, { allowCustomSession: true })
    for (const name of ['task_create', 'task_update']) {
      expect(validateJsonSchemaValue(tool(on, name).parameters as never, args as never)).toEqual([])
    }
  })

  it('写 / 读 / 列表 / 删除工具的 output.schema required 与实现一致', () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    expect(tool(tools, 'task_create').output.schema.required).toEqual(['ok', 'task'])
    expect(tool(tools, 'task_update').output.schema.required).toEqual(['ok', 'task'])
    expect(tool(tools, 'task_enable').output.schema.required).toEqual(['ok', 'task'])
    expect(tool(tools, 'task_disable').output.schema.required).toEqual(['ok', 'task'])
    expect(tool(tools, 'task_get').output.schema.required).toEqual(['task'])
    expect(tool(tools, 'task_delete').output.schema.required).toEqual(['ok', 'id'])
    expect(tool(tools, 'task_list').output.schema.required).toEqual(['tasks'])
    expect(tool(tools, 'task_run_now').output.schema.required).toEqual(['kind', 'reason'])
  })

  it('渲染函数覆盖空列表 / 损坏列表 / 两种 kind 的读取结果', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    writeFileSync(join(fixture.tasksDir, 'broken.json'), '{ oops', 'utf8')
    const tools = makeTools(fixture)

    const listed = tool(tools, 'task_list').output.render({} as never, { tasks: [] } as never)
    expect((listed[0] as { text: string }).text).toMatch(/暂无定时任务/)

    const withCorrupted = tool(tools, 'task_list').output.render(
      {} as never,
      { tasks: [], corrupted: ['broken'] } as never,
    )
    expect((withCorrupted[0] as { text: string }).text).toMatch(/损坏文件/)

    const textView = (await call(tools, 'task_get', { id: RICH_TEXT.id })) as never
    const rendered = tool(tools, 'task_get').output.render({ id: RICH_TEXT.id } as never, textView)
    expect((rendered[0] as { text: string }).text).toMatch(/text: 原始正文/)
  })
})

// ---------------------------------------------------------------------------
// TaskView 细节
// ---------------------------------------------------------------------------

describe('TaskView 细节', () => {
  it('text 视图：warnings 恒为 []、无 task_path、有 session_id', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const tools = makeTools(fixture)
    const value = (await call(tools, 'task_get', { id: RICH_TEXT.id })) as {
      task: Record<string, unknown>
    }
    expect(value.task.warnings).toEqual([])
    expect(value.task).not.toHaveProperty('task_path')
    expect(value.task.session_id).toBe('ou_text_session')
    for (const key of ['id', 'name', 'cron', 'enabled', 'kind', 'warnings']) {
      expect(value.task).toHaveProperty(key)
    }
  })

  it('script 视图：无 text、有 task_path，程序缺失时 warnings 指出不可用', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_SCRIPT })
    rmSync(fixture.scriptPath)
    const tools = makeTools(fixture)
    const value = (await call(tools, 'task_get', { id: RICH_SCRIPT.id })) as {
      task: Record<string, unknown>
    }
    expect(value.task).not.toHaveProperty('text')
    expect(value.task.task_path).toBe('programs/hello.ts')
    expect((value.task.warnings as string[]).join('\n')).toMatch(/任务程序当前不可用.*not found/)
  })

  it('损坏任务文件按「不存在」报错（语义错误抛错）', async () => {
    const fixture = makeFixture()
    writeFileSync(join(fixture.tasksDir, 'corrupted.json'), '{ not-json', 'utf8')
    const tools = makeTools(fixture)
    await expect(call(tools, 'task_get', { id: 'corrupted' })).rejects.toThrow(/任务 corrupted 不存在/)
  })

  // 已知风险：warnings 只做 L2（存在 / 普通文件 / 可读），不做 L1 扩展名检查。
  // 手工落盘 / 迁移来的 `legacy.py` 任务在视图里 warnings 为空，但 runner 触发时
  // 会因扩展名白名单直接 failed/runtime。建议 scriptWarnings 复用 validateScript。
  it.fails('已知风险：script 扩展名非法（手工落盘）时 warnings 未提示不可用', async () => {
    const fixture = makeFixture()
    writeFileSync(join(fixture.workspace, 'programs', 'legacy.py'), 'print(1)\n', 'utf8')
    fixture.store.save({
      id: 'legacy-py',
      name: '旧脚本',
      cron: '0 9 * * *',
      enabled: true,
      task_path: 'programs/legacy.py',
    })
    const tools = makeTools(fixture)
    const value = (await call(tools, 'task_get', { id: 'legacy-py' })) as {
      task: { warnings: string[] }
    }
    expect(value.task.warnings.join('\n')).toMatch(/不可用|扩展名/)
  })
})

// ---------------------------------------------------------------------------
// onChange 失败路径
// ---------------------------------------------------------------------------

describe('onChange 失败路径', () => {
  it('onChange 在 update / enable / disable / delete 抛错时均只 warn，工具仍成功', async () => {
    const fixture = makeFixture()
    fixture.store.save({ ...RICH_TEXT })
    const warn = vi.fn()
    const tools = makeTools(fixture, {
      onChange: () => {
        throw new Error('reload 炸了')
      },
      logger: { warn },
    })

    await call(tools, 'task_update', { id: RICH_TEXT.id, name: '仍成功' })
    await call(tools, 'task_enable', { id: RICH_TEXT.id })
    await call(tools, 'task_disable', { id: RICH_TEXT.id })
    await call(tools, 'task_delete', { id: RICH_TEXT.id })

    expect(warn).toHaveBeenCalledTimes(4)
    expect(existsSync(join(fixture.tasksDir, `${RICH_TEXT.id}.json`))).toBe(false)
  })

  it('未注入 logger 时 onChange 抛错也不反向失败', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, {
      onChange: () => {
        throw new Error('no logger')
      },
    })
    const value = (await call(tools, 'task_create', {
      id: 'no-logger',
      name: 'x',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
    })) as { ok: boolean }
    expect(value.ok).toBe(true)
    expect(fixture.store.get('no-logger')).toBeDefined()
  })

  it('写操作被拒时不触发 onChange', async () => {
    const fixture = makeFixture()
    let changes = 0
    const tools = makeTools(fixture, { onChange: () => void (changes += 1) })

    await expect(
      call(tools, 'task_create', { id: 'bad', name: '', cron: '0 9 * * *', task_path: 'programs/hello.ts' }),
    ).rejects.toThrow()
    await expect(call(tools, 'task_update', { id: 'ghost', name: 'x' })).rejects.toThrow(/不存在/)
    await expect(call(tools, 'task_delete', { id: 'ghost' })).rejects.toThrow(/不存在/)

    expect(changes).toBe(0)
  })

  it('每次成功写恰好调用一次 onChange（含 text 任务）', async () => {
    const fixture = makeFixture()
    let changes = 0
    const tools = makeTools(fixture, { onChange: () => void (changes += 1) })
    await call(tools, 'task_create', {
      id: 'counted',
      name: 'x',
      cron: '0 9 * * *',
      kind: 'text',
      text: 'hi',
    })
    expect(changes).toBe(1)
    await call(tools, 'task_update', { id: 'counted', text: 'hi2' })
    expect(changes).toBe(2)
    await call(tools, 'task_delete', { id: 'counted' })
    expect(changes).toBe(3)
  })
})
