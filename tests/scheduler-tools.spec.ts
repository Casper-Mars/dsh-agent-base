/**
 * 任务工具层（8 个 task_*）：入参矩阵 / kind 交叉约束 / 路径校验 /
 * session 开关 / 整文件重写保留字段 / onChange / run_now。
 *
 * 全部使用临时目录中的真实任务文件，绝不写用户目录；不启动子进程。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskStore, resolveTasksDir } from '../src/scheduler/store.js'
import {
  SCHEDULER_TOOL_NAMES,
  SchedulerToolError,
  createSchedulerTools,
} from '../src/scheduler/tools.js'
import type { SchedulerToolsOptions } from '../src/scheduler/tools.js'
import type { TaskStore } from '../src/scheduler/store.js'
import type { TaskDef, TaskRunOutcome } from '../src/scheduler/types.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

// ---------------------------------------------------------------------------
// 极简 JSON Schema 校验（只覆盖工具出参用到的子集；不引入运行时依赖）
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>

function schemaError(path: string, detail: string): never {
  throw new Error(`输出 schema 校验失败 @ ${path}：${detail}`)
}

function validateSchema(value: unknown, schema: Schema, path = '$'): void {
  if (schema.enum !== undefined) {
    const allowed = schema.enum as unknown[]
    if (!allowed.some((item) => Object.is(item, value))) {
      schemaError(path, `值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(allowed)} 中`)
    }
  }
  const type = schema.type as string | undefined
  switch (type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        schemaError(path, `应为 object，实际为 ${Array.isArray(value) ? 'array' : typeof value}`)
      }
      const record = value as Record<string, unknown>
      const properties = (schema.properties ?? {}) as Record<string, Schema>
      for (const key of (schema.required ?? []) as string[]) {
        if (!(key in record)) schemaError(path, `缺少必填字段 ${key}`)
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = properties[key]
        if (childSchema === undefined) {
          if (schema.additionalProperties === false) schemaError(path, `出现未声明字段 ${key}`)
          continue
        }
        validateSchema(child, childSchema, `${path}.${key}`)
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) schemaError(path, `应为 array，实际为 ${typeof value}`)
      if (schema.items !== undefined) {
        value.forEach((item, index) => validateSchema(item, schema.items as Schema, `${path}[${index}]`))
      }
      break
    }
    case 'string':
      if (typeof value !== 'string') schemaError(path, `应为 string，实际为 ${typeof value}`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) schemaError(path, '应为 number')
      break
    case 'boolean':
      if (typeof value !== 'boolean') schemaError(path, '应为 boolean')
      break
    case undefined:
      break
    default:
      schemaError(path, `测试校验器不支持 type=${type}`)
  }
}

// ---------------------------------------------------------------------------
// 临时 workspace / 任务存储 / 工具集
// ---------------------------------------------------------------------------

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-base-tools-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const tasksDir = resolveTasksDir(workspace)
  mkdirSync(tasksDir, { recursive: true })
  const scriptPath = join(workspace, 'programs', 'hello.ts')
  mkdirSync(dirname(scriptPath), { recursive: true })
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

async function call(
  tools: ToolDefinition[],
  name: string,
  args: unknown,
): Promise<{ value: unknown; tool: ToolDefinition }> {
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`未找到工具 ${name}`)
  const value = await tool.execute(args, {} as never)
  validateSchema(value, tool.output.schema as unknown as Schema)
  const blocks = tool.output.render(args, value as never)
  expect(Array.isArray(blocks)).toBe(true)
  expect(blocks.length).toBeGreaterThan(0)
  for (const block of blocks) expect((block as { type?: string }).type).toBe('text')
  expect(typeof (blocks[0] as { text?: unknown }).text).toBe('string')
  return { value, tool }
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`未找到工具 ${name}`)
  return found
}

function seed(store: TaskStore, task: TaskDef): void {
  store.save(task)
}

const SCRIPT_TASK: TaskDef = {
  id: 'seeded-script',
  name: '已有脚本任务',
  cron: '0 9 * * *',
  task_path: 'programs/hello.ts',
  enabled: true,
  session_id: 'ou_seeded_session',
}

// ---------------------------------------------------------------------------
// 工具契约
// ---------------------------------------------------------------------------

describe('工具契约', () => {
  it('构造 8 个工具，名称 / 描述 / parameters / output 完整', () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    expect(tools.map((item) => item.name)).toEqual([...SCHEDULER_TOOL_NAMES])
    expect(tools).toHaveLength(8)
    for (const item of tools) {
      expect(item.description.length).toBeGreaterThan(0)
      expect(item.parameters).toMatchObject({ type: 'object', additionalProperties: false })
      expect(item.output.schema).toMatchObject({ type: 'object' })
      expect(typeof item.output.render).toBe('function')
      expect(item.execute).toBeInstanceOf(Function)
    }
  })

  it('8 个工具的入参 / 出参矩阵均可渲染且通过 output.schema', async () => {
    const fixture = makeFixture()
    const seen: string[] = []
    const tools = makeTools(fixture, {
      runNow: async (id): Promise<TaskRunOutcome> => {
        seen.push(id)
        return { kind: 'quiet', reason: '无需投递' }
      },
    })

    await call(tools, 'task_create', {
      id: 'matrix',
      name: '矩阵任务',
      cron: '*/5 * * * *',
      kind: 'script',
      task_path: 'programs/hello.ts',
    })
    await call(tools, 'task_list', {})
    await call(tools, 'task_get', { id: 'matrix' })
    await call(tools, 'task_update', { id: 'matrix', name: '改名任务', cron: '10 * * * *' })
    await call(tools, 'task_disable', { id: 'matrix' })
    await call(tools, 'task_enable', { id: 'matrix' })
    await call(tools, 'task_run_now', { id: 'matrix' })
    await call(tools, 'task_delete', { id: 'matrix' })

    expect(seen).toEqual(['matrix'])
    expect(existsSync(join(fixture.tasksDir, 'matrix.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 创建 / kind 交叉约束
// ---------------------------------------------------------------------------

describe('task_create 与 kind 交叉约束', () => {
  it('创建 script 任务（缺省 kind），落盘并在视图中返回 script 字段', async () => {
    const fixture = makeFixture()
    let changes = 0
    const tools = makeTools(fixture, { onChange: () => void (changes += 1) })
    const { value } = await call(tools, 'task_create', {
      id: 'daily',
      name: '每日任务',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
    })
    const view = (value as { task: Record<string, unknown> }).task
    expect(view).toMatchObject({
      id: 'daily',
      name: '每日任务',
      cron: '0 9 * * *',
      enabled: true,
      kind: 'script',
      task_path: 'programs/hello.ts',
      warnings: [],
    })
    expect(view).not.toHaveProperty('text')
    expect(fixture.store.get('daily')).toMatchObject({ id: 'daily', task_path: 'programs/hello.ts' })
    expect(changes).toBe(1)
  })

  it('创建 text 任务：返回 text，不返回 task_path', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    const { value } = await call(tools, 'task_create', {
      id: 'note',
      name: '文本任务',
      cron: '0 8 * * *',
      kind: 'text',
      text: '早上好',
    })
    const view = (value as { task: Record<string, unknown> }).task
    expect(view).toMatchObject({ kind: 'text', text: '早上好' })
    expect(view).not.toHaveProperty('task_path')
  })

  it('拒绝 4 种非法 kind 组合', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    const cases: Array<{ args: Record<string, unknown>; pattern: RegExp }> = [
      {
        args: { id: 'bad1', name: 'x', cron: '0 9 * * *', kind: 'script', text: '不该出现' },
        pattern: /script 任务不得提供 text/,
      },
      {
        args: { id: 'bad2', name: 'x', cron: '0 9 * * *', kind: 'script' },
        pattern: /必须提供 task_path/,
      },
      {
        args: { id: 'bad3', name: 'x', cron: '0 9 * * *', kind: 'text', text: 'x', task_path: 'programs/hello.ts' },
        pattern: /text 任务不得提供 task_path/,
      },
      {
        args: { id: 'bad4', name: 'x', cron: '0 9 * * *', kind: 'text' },
        pattern: /text 任务必须提供 text/,
      },
    ]
    for (const { args, pattern } of cases) {
      await expect(call(tools, 'task_create', args)).rejects.toThrow(pattern)
      expect(fixture.store.get(String(args.id))).toBeUndefined()
    }
  })

  it('kind 非法时给出可读错误', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_create', { id: 'bad-kind', name: 'x', cron: '0 9 * * *', kind: 'shell' }),
    ).rejects.toThrow(/kind 只能是/)
  })

  it('id 已存在时拒绝覆盖', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_create', {
        id: SCRIPT_TASK.id,
        name: '重复',
        cron: '0 9 * * *',
        task_path: 'programs/hello.ts',
      }),
    ).rejects.toThrow(/已存在/)
  })
})

// ---------------------------------------------------------------------------
// 路径校验
// ---------------------------------------------------------------------------

describe('task_path 校验', () => {
  it('接受任意相对目录（不设 programs/ 白名单）与 .mjs / .cjs / .js', async () => {
    const fixture = makeFixture()
    for (const rel of ['any/deep/task.mjs', 'elsewhere/x.cjs', 'root.js']) {
      const target = join(fixture.workspace, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, 'export default 1\n', 'utf8')
    }
    const tools = makeTools(fixture)
    for (const [index, rel] of ['any/deep/task.mjs', 'elsewhere/x.cjs', 'root.js'].entries()) {
      const { value } = await call(tools, 'task_create', {
        id: `path-${index}`,
        name: '路径任务',
        cron: '0 9 * * *',
        task_path: rel,
      })
      expect((value as { task: { task_path: string } }).task.task_path).toBe(rel)
    }
  })

  it('接受 workspace 之外的绝对路径与 .ts 扩展名', async () => {
    const fixture = makeFixture()
    const outside = join(fixture.root, 'outside', 'abs.ts')
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, 'export default 2\n', 'utf8')
    const tools = makeTools(fixture)
    const { value } = await call(tools, 'task_create', {
      id: 'absolute',
      name: '绝对路径任务',
      cron: '0 9 * * *',
      task_path: outside,
    })
    expect((value as { task: { task_path: string } }).task.task_path).toBe(outside)
  })

  it('缺文件：错误包含解析后的绝对路径与 not found', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    const expected = join(fixture.workspace, 'programs', 'missing.js')
    await expect(
      call(tools, 'task_create', {
        id: 'missing',
        name: '缺失',
        cron: '0 9 * * *',
        task_path: 'programs/missing.js',
      }),
    ).rejects.toThrow(new RegExp(`不存在.*${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('目录：错误说明不是普通文件', async () => {
    const fixture = makeFixture()
    mkdirSync(join(fixture.workspace, 'programs', 'dir.js'), { recursive: true })
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_create', {
        id: 'dir',
        name: '目录',
        cron: '0 9 * * *',
        task_path: 'programs/dir.js',
      }),
    ).rejects.toThrow(/不是普通文件/)
  })

  it('不可读：错误说明 not readable', async () => {
    const fixture = makeFixture()
    const target = join(fixture.workspace, 'programs', 'secret.js')
    writeFileSync(target, 'export default 3\n', 'utf8')
    chmodSync(target, 0o000)
    try {
      const tools = makeTools(fixture)
      await expect(
        call(tools, 'task_create', {
          id: 'secret',
          name: '不可读',
          cron: '0 9 * * *',
          task_path: 'programs/secret.js',
        }),
      ).rejects.toThrow(/不可读（not readable）/)
    } finally {
      chmodSync(target, 0o644)
    }
  })

  it('扩展名非法：错误包含绝对路径与具体原因', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    const expected = join(fixture.workspace, 'programs', 'hello.py')
    await expect(
      call(tools, 'task_create', {
        id: 'py',
        name: '脚本',
        cron: '0 9 * * *',
        task_path: 'programs/hello.py',
      }),
    ).rejects.toThrow(new RegExp(`扩展名不受支持.*${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('更新时同样强校验新 task_path', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_update', { id: SCRIPT_TASK.id, task_path: 'programs/not-there.js' }),
    ).rejects.toThrow(/不存在/)
  })
})

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

describe('cron 校验', () => {
  it('拒绝 6 段表达式', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_create', {
        id: 'cron6',
        name: '六段',
        cron: '0 0 9 * * *',
        task_path: 'programs/hello.ts',
      }),
    ).rejects.toThrow(/应含 5 段/)
  })

  it('拒绝越界取值且错误可读', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_create', {
        id: 'cron-bad',
        name: '越界',
        cron: '60 * * * *',
        task_path: 'programs/hello.ts',
      }),
    ).rejects.toThrow(/超出范围 0-59/)
  })
})

// ---------------------------------------------------------------------------
// session 开关
// ---------------------------------------------------------------------------

describe('session 开关', () => {
  it('关闭时：create / update 的 parameters 不含 session_id', () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, { allowCustomSession: false })
    for (const name of ['task_create', 'task_update']) {
      const definition = tool(tools, name)
      const properties = definition.parameters.properties as Record<string, unknown>
      expect(properties).not.toHaveProperty('session_id')
      // additionalProperties: false 会在注册层直接拒绝关闭时传入的 session_id。
      expect(() =>
        validateSchema(
          { id: 'x', name: 'x', cron: '0 9 * * *', task_path: 'programs/hello.ts', session_id: 'ou_x' },
          definition.parameters as unknown as Schema,
        ),
      ).toThrow(/未声明字段 session_id/)
    }
  })

  it('关闭时：即使直接调用 execute 传入 session_id 也被拒绝', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, { allowCustomSession: false })
    await expect(
      call(tools, 'task_create', {
        id: 'no-session',
        name: '无会话',
        cron: '0 9 * * *',
        task_path: 'programs/hello.ts',
        session_id: 'ou_any',
      }),
    ).rejects.toThrow(/allowCustomSession=false/)
  })

  it('关闭时：整文件重写保留磁盘上已有的 session_id（改名 / enable / disable）', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    const tools = makeTools(fixture, { allowCustomSession: false })

    await call(tools, 'task_update', { id: SCRIPT_TASK.id, name: '改名后' })
    expect(fixture.store.get(SCRIPT_TASK.id)?.session_id).toBe('ou_seeded_session')

    await call(tools, 'task_disable', { id: SCRIPT_TASK.id })
    expect(fixture.store.get(SCRIPT_TASK.id)?.session_id).toBe('ou_seeded_session')
    expect(fixture.store.get(SCRIPT_TASK.id)?.enabled).toBe(false)

    await call(tools, 'task_enable', { id: SCRIPT_TASK.id })
    expect(fixture.store.get(SCRIPT_TASK.id)?.session_id).toBe('ou_seeded_session')
    expect(fixture.store.get(SCRIPT_TASK.id)?.enabled).toBe(true)
  })

  it('开启时：parameters 含 session_id，接受任意合法 id（不校验会话存在）', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, { allowCustomSession: true })
    for (const name of ['task_create', 'task_update']) {
      const properties = tool(tools, name).parameters.properties as Record<string, unknown>
      expect(properties).toHaveProperty('session_id')
    }
    const { value } = await call(tools, 'task_create', {
      id: 'custom-session',
      name: '自定义会话',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
      session_id: 'ou_does_not_exist_yet',
    })
    expect((value as { task: Record<string, unknown> }).task.session_id).toBe('ou_does_not_exist_yet')
    expect(fixture.store.get('custom-session')?.session_id).toBe('ou_does_not_exist_yet')
  })

  it('开启时：update 可设置 session_id，之后关闭开关再改名仍保留', async () => {
    const fixture = makeFixture()
    const withSession = makeTools(fixture, { allowCustomSession: true })
    await call(withSession, 'task_create', {
      id: 'swap',
      name: '会话',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
    })
    await call(withSession, 'task_update', { id: 'swap', session_id: 'ou_new' })
    expect(fixture.store.get('swap')?.session_id).toBe('ou_new')

    const withoutSession = makeTools(fixture, { allowCustomSession: false })
    await call(withoutSession, 'task_update', { id: 'swap', name: '再次改名' })
    expect(fixture.store.get('swap')?.session_id).toBe('ou_new')
  })
})

// ---------------------------------------------------------------------------
// allowScript
// ---------------------------------------------------------------------------

describe('allowScript 开关', () => {
  it('关闭时拒绝创建 / 更新 script 任务，但已有 script 任务仍可读', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    const tools = makeTools(fixture, { allowScript: false })

    const { value } = await call(tools, 'task_get', { id: SCRIPT_TASK.id })
    expect((value as { task: { kind: string } }).task.kind).toBe('script')

    await expect(
      call(tools, 'task_create', {
        id: 'blocked',
        name: '被拒',
        cron: '0 9 * * *',
        task_path: 'programs/hello.ts',
      }),
    ).rejects.toThrow(/allowScript=false/)

    await expect(
      call(tools, 'task_update', { id: SCRIPT_TASK.id, name: '改名' }),
    ).rejects.toThrow(/allowScript=false/)
  })

  it('关闭时仍可创建 text 任务', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, { allowScript: false })
    const { value } = await call(tools, 'task_create', {
      id: 'text-ok',
      name: '文本',
      cron: '0 9 * * *',
      kind: 'text',
      text: 'hello',
    })
    expect((value as { task: { kind: string } }).task.kind).toBe('text')
  })
})

// ---------------------------------------------------------------------------
// 读取 / 列表 / 更新 / 删除
// ---------------------------------------------------------------------------

describe('读取与列表', () => {
  it('列表按 id 升序，返回损坏文件清单与 warning', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    seed(fixture.store, {
      id: 'aaa',
      name: '文本',
      cron: '0 9 * * *',
      enabled: false,
      kind: 'text',
      text: 'x',
    })
    writeFileSync(join(fixture.tasksDir, 'broken.json'), '{ not json', 'utf8')

    const tools = makeTools(fixture)
    const { value } = await call(tools, 'task_list', {})
    const result = value as { tasks: Array<{ id: string }>; corrupted?: string[] }
    expect(result.tasks.map((item) => item.id)).toEqual(['aaa', SCRIPT_TASK.id])
    expect(result.corrupted).toEqual(['broken'])
  })

  it('程序文件消失后读取不报错，只给非破坏性 warning', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    rmSync(fixture.scriptPath)
    const tools = makeTools(fixture)
    const { value } = await call(tools, 'task_get', { id: SCRIPT_TASK.id })
    const view = (value as { task: { warnings: string[] } }).task
    expect(view.warnings).toHaveLength(1)
    expect(view.warnings[0]).toMatch(/任务程序当前不可用/)
  })

  it('get / delete 不存在的 id 均报错', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    await expect(call(tools, 'task_get', { id: 'ghost' })).rejects.toThrow(/不存在/)
    await expect(call(tools, 'task_delete', { id: 'ghost' })).rejects.toThrow(/不存在/)
  })
})

describe('task_update 语义', () => {
  it('未提供字段保持原值；显式 kind 可完成 text ↔ script 转换', async () => {
    const fixture = makeFixture()
    seed(fixture.store, {
      id: 'convert',
      name: '原文本',
      cron: '0 9 * * *',
      enabled: true,
      kind: 'text',
      text: '旧正文',
    })
    const tools = makeTools(fixture)

    await call(tools, 'task_update', { id: 'convert', name: '保留 cron' })
    expect(fixture.store.get('convert')).toMatchObject({ cron: '0 9 * * *', text: '旧正文' })

    await call(tools, 'task_update', {
      id: 'convert',
      kind: 'script',
      task_path: 'programs/hello.ts',
    })
    const converted = fixture.store.get('convert')
    expect(converted?.kind).toBeUndefined()
    expect(converted).toMatchObject({
      task_path: 'programs/hello.ts',
      name: '保留 cron',
      cron: '0 9 * * *',
    })

    await call(tools, 'task_update', { id: 'convert', kind: 'text', text: '新正文' })
    expect(fixture.store.get('convert')).toMatchObject({ kind: 'text', text: '新正文' })
  })

  it('切换 kind 时缺失目标字段 / 携带错误字段都会被拒', async () => {
    const fixture = makeFixture()
    seed(fixture.store, {
      id: 'conv2',
      name: '文本',
      cron: '0 9 * * *',
      enabled: true,
      kind: 'text',
      text: 'x',
    })
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_update', { id: 'conv2', kind: 'script' }),
    ).rejects.toThrow(/必须提供 task_path/)
    await expect(
      call(tools, 'task_update', { id: 'conv2', kind: 'script', task_path: 'programs/hello.ts', text: 'y' }),
    ).rejects.toThrow(/不得提供 text/)
  })
})

describe('task_delete', () => {
  it('只删除定义文件，不删除任务程序', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    const tools = makeTools(fixture)
    const { value } = await call(tools, 'task_delete', { id: SCRIPT_TASK.id })
    expect(value).toEqual({ ok: true, id: SCRIPT_TASK.id })
    expect(existsSync(join(fixture.tasksDir, `${SCRIPT_TASK.id}.json`))).toBe(false)
    expect(existsSync(fixture.scriptPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// onChange / run_now
// ---------------------------------------------------------------------------

describe('onChange 与 task_run_now', () => {
  it('每次写成功调用一次 onChange', async () => {
    const fixture = makeFixture()
    let changes = 0
    const tools = makeTools(fixture, { onChange: () => void (changes += 1) })

    await call(tools, 'task_create', {
      id: 'change',
      name: '变更',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
    })
    expect(changes).toBe(1)
    await call(tools, 'task_update', { id: 'change', name: '变更2' })
    expect(changes).toBe(2)
    await call(tools, 'task_disable', { id: 'change' })
    expect(changes).toBe(3)
    await call(tools, 'task_enable', { id: 'change' })
    expect(changes).toBe(4)
    await call(tools, 'task_delete', { id: 'change' })
    expect(changes).toBe(5)

    // 只读操作不触发。
    await call(tools, 'task_list', {})
    expect(changes).toBe(5)
  })

  it('onChange 抛错只 warn，不影响工具成功', async () => {
    const fixture = makeFixture()
    const warn = vi.fn()
    const tools = makeTools(fixture, {
      onChange: () => {
        throw new Error('reload 炸了')
      },
      logger: { warn },
    })
    const { value } = await call(tools, 'task_create', {
      id: 'resilient',
      name: '容错',
      cron: '0 9 * * *',
      task_path: 'programs/hello.ts',
    })
    expect((value as { ok: boolean }).ok).toBe(true)
    expect(fixture.store.get('resilient')).toBeDefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/reload 失败/)
  })

  it('run_now 调用注入的 runNow 并返回结局（不触发 onChange）', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    const seen: string[] = []
    let changes = 0
    const outcome: TaskRunOutcome = {
      kind: 'woke',
      reason: '已投递',
      data: '结果',
      targets: ['ou_main'],
    }
    const tools = makeTools(fixture, {
      onChange: () => void (changes += 1),
      runNow: async (id) => {
        seen.push(id)
        return outcome
      },
    })
    const { value } = await call(tools, 'task_run_now', { id: SCRIPT_TASK.id })
    expect(value).toEqual(outcome)
    expect(seen).toEqual([SCRIPT_TASK.id])
    expect(changes).toBe(0)
  })

  it('run_now 缺省 runNow 时给出明确错误', async () => {
    const fixture = makeFixture()
    seed(fixture.store, { ...SCRIPT_TASK })
    const tools = makeTools(fixture)
    await expect(call(tools, 'task_run_now', { id: SCRIPT_TASK.id })).rejects.toThrow(
      /未提供立即执行能力/,
    )
  })

  it('run_now 对不存在的任务报错', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture, { runNow: async () => ({ kind: 'quiet', reason: 'x' }) })
    await expect(call(tools, 'task_run_now', { id: 'ghost' })).rejects.toThrow(/不存在/)
  })
})

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

describe('错误类型', () => {
  it('语义错误统一抛 SchedulerToolError', async () => {
    const fixture = makeFixture()
    const tools = makeTools(fixture)
    await expect(
      call(tools, 'task_create', { id: '', name: 'x', cron: '0 9 * * *', task_path: 'programs/hello.ts' }),
    ).rejects.toBeInstanceOf(SchedulerToolError)
  })
})
