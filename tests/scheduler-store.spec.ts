/**
 * 任务定义存储：id 防穿越 / 目录解析 / 结构守卫 / 损坏隔离 / 原子写。
 *
 * 从 dsh-rsi-agent 移植，删除了所有 git / 资产仓（commitAssets）用例；
 * 新增 D4 的 `resolveTasksDir` 与原子写（无 `.tmp` 残留）用例。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_COOLDOWN_MS,
  TaskStoreError,
  assertTaskId,
  createTaskStore,
  isTaskDef,
  resolveTasksDir,
  type TaskStoreOptions,
} from '../src/scheduler/store.js'
import type { TaskDef } from '../src/scheduler/types.js'

const roots: string[] = []

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-base-tasks-'))
  roots.push(root)
  return root
}

function tempStore(options: { readonly logger?: TaskStoreOptions['logger'] } = {}) {
  const workspace = tempWorkspace()
  const tasksDir = resolveTasksDir(workspace)
  mkdirSync(tasksDir, { recursive: true })
  return { workspace, tasksDir, store: createTaskStore({ tasksDir, ...options }) }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

const TASK: TaskDef = {
  id: 'demo',
  name: '示例任务',
  cron: '0 9 * * *',
  task_path: 'programs/demo/task.ts',
  enabled: true,
}

describe('任务 id 防目录穿越', () => {
  it('接受字母数字开头的常规 id', () => {
    expect(assertTaskId('market-pulse')).toBe('market-pulse')
    expect(assertTaskId('a.b_c-1')).toBe('a.b_c-1')
  })

  it('拒绝空串 / 特殊路径段', () => {
    expect(() => assertTaskId('')).toThrow(TaskStoreError)
    expect(() => assertTaskId('.')).toThrow(/特殊路径段/)
    expect(() => assertTaskId('..')).toThrow(/特殊路径段/)
  })

  it('拒绝路径分隔符与反斜杠', () => {
    expect(() => assertTaskId('../etc/passwd')).toThrow(/路径分隔符/)
    expect(() => assertTaskId('a/b')).toThrow(/路径分隔符/)
    expect(() => assertTaskId('a\\b')).toThrow(/路径分隔符/)
  })

  it('拒绝空字符与超长 id', () => {
    expect(() => assertTaskId('a\0b')).toThrow(/空字符/)
    expect(() => assertTaskId(`a${'b'.repeat(200)}`)).toThrow(/必须匹配/)
  })

  it('get 对穿越 id 抛错（编程错误要响亮）', () => {
    const { store } = tempStore()
    expect(() => store.get('../../evil')).toThrow(/路径分隔符/)
  })

  it('filePath 拼接结果始终位于 tasksDir 下', () => {
    const { tasksDir, store } = tempStore()
    expect(store.filePath('demo')).toBe(join(tasksDir, 'demo.json'))
  })
})

describe('resolveTasksDir · D4 目录约束', () => {
  it('缺省为 <workspace>/.agent-base/tasks', () => {
    const workspace = tempWorkspace()
    expect(resolveTasksDir(workspace)).toBe(join(workspace, '.agent-base', 'tasks'))
  })

  it('相对覆盖路径落到 workspace 内', () => {
    const workspace = tempWorkspace()
    expect(resolveTasksDir(workspace, 'custom/tasks')).toBe(join(workspace, 'custom', 'tasks'))
    expect(resolveTasksDir(workspace, 'a/../tasks')).toBe(join(workspace, 'tasks'))
  })

  it('绝对路径一律拒绝', () => {
    const workspace = tempWorkspace()
    expect(() => resolveTasksDir(workspace, join(workspace, 'abs'))).toThrow(/绝对路径/)
    expect(() => resolveTasksDir(workspace, '/tmp')).toThrow(TaskStoreError)
  })

  it('`..` 越界拒绝', () => {
    const workspace = tempWorkspace()
    expect(() => resolveTasksDir(workspace, '../outside')).toThrow(/越出 workspace/)
    expect(() => resolveTasksDir(workspace, 'a/../../outside')).toThrow(/越出 workspace/)
  })

  it('空 tasksDir / 非绝对 workspace 拒绝', () => {
    const workspace = tempWorkspace()
    expect(() => resolveTasksDir(workspace, '')).toThrow(/非空字符串/)
    expect(() => resolveTasksDir('relative/workspace')).toThrow(/绝对路径/)
  })
})

describe('任务结构守卫', () => {
  it('合法 script（kind 缺省）与 text 返回 true', () => {
    expect(isTaskDef(TASK)).toBe(true)
    expect(isTaskDef({ ...TASK, kind: 'script', text: undefined })).toBe(true)
    expect(
      isTaskDef({ id: 't', name: '文本', cron: '* * * * *', enabled: true, kind: 'text', text: 'hi' }),
    ).toBe(true)
  })

  it('缺字段 / 类型不符 / 非对象一律 false', () => {
    expect(isTaskDef({ ...TASK, enabled: 'yes' })).toBe(false)
    expect(isTaskDef({ ...TASK, cron: undefined })).toBe(false)
    expect(isTaskDef({ ...TASK, name: '' })).toBe(false)
    expect(isTaskDef({ ...TASK, session_id: 42 })).toBe(false)
    expect(isTaskDef(null)).toBe(false)
    expect(isTaskDef([])).toBe(false)
  })

  it('id 非法的记录也不算有效任务', () => {
    expect(isTaskDef({ ...TASK, id: '../x' })).toBe(false)
  })

  it('kind 交叉约束：script 不得带 text / text 不得带 task_path', () => {
    expect(isTaskDef({ ...TASK, text: 'hi' })).toBe(false)
    expect(isTaskDef({ ...TASK, kind: 'script', text: 'hi' })).toBe(false)
    expect(isTaskDef({ ...TASK, kind: 'text' })).toBe(false)
    expect(isTaskDef({ ...TASK, kind: 'text', text: 'hi', task_path: undefined })).toBe(true)
    expect(
      isTaskDef({ id: 't', name: 'n', cron: '* * * * *', enabled: true, kind: 'text', task_path: 'p' }),
    ).toBe(false)
  })

  it('script 缺 task_path / 空 task_path 拒绝', () => {
    expect(isTaskDef({ id: 't', name: 'n', cron: '* * * * *', enabled: true })).toBe(false)
    expect(isTaskDef({ ...TASK, task_path: '   ' })).toBe(false)
  })

  it('未知 kind 一律 false', () => {
    expect(isTaskDef({ ...TASK, kind: 'http' })).toBe(false)
  })

  it('cooldown_ms 必须落在 0–3600000', () => {
    expect(isTaskDef({ ...TASK, cooldown_ms: 0 })).toBe(true)
    expect(isTaskDef({ ...TASK, cooldown_ms: MAX_COOLDOWN_MS })).toBe(true)
    expect(isTaskDef({ ...TASK, cooldown_ms: -1 })).toBe(false)
    expect(isTaskDef({ ...TASK, cooldown_ms: MAX_COOLDOWN_MS + 1 })).toBe(false)
    expect(isTaskDef({ ...TASK, cooldown_ms: '5' })).toBe(false)
  })
})

describe('读写与损坏文件', () => {
  it('save 后 get / list 立即可读（跨实例恢复）', () => {
    const { tasksDir } = tempStore()
    createTaskStore({ tasksDir }).save(TASK)
    const store = createTaskStore({ tasksDir })
    expect(store.get('demo')).toEqual(TASK)
    expect(store.list().tasks).toEqual([TASK])
  })

  it('save 落盘格式为可读 JSON（带换行）', () => {
    const { tasksDir, store } = tempStore()
    store.save(TASK)
    const raw = readFileSync(join(tasksDir, 'demo.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual(TASK)
  })

  it('list 按 id 升序', () => {
    const { store } = tempStore()
    store.save({ ...TASK, id: 'zeta' })
    store.save({ ...TASK, id: 'alpha' })
    expect(store.list().tasks.map((task) => task.id)).toEqual(['alpha', 'zeta'])
  })

  it('损坏 JSON / 结构非法 → 归入 corrupted，不中断其它任务', () => {
    const { tasksDir, store } = tempStore()
    store.save({ ...TASK, id: 'good' })
    writeFileSync(join(tasksDir, 'broken.json'), '{not json', 'utf8')
    writeFileSync(join(tasksDir, 'shape.json'), JSON.stringify({ id: 'shape' }), 'utf8')
    const result = store.list()
    expect(result.tasks.map((task) => task.id)).toEqual(['good'])
    expect(result.corrupted.sort()).toEqual(['broken', 'shape'])
  })

  it('非 .json 文件被忽略', () => {
    const { tasksDir, store } = tempStore()
    writeFileSync(join(tasksDir, 'note.md'), '# nope', 'utf8')
    expect(store.list()).toEqual({ tasks: [], corrupted: [] })
  })

  it('目录不存在 → 空清单', () => {
    const workspace = tempWorkspace()
    const store = createTaskStore({ tasksDir: join(workspace, 'missing', 'tasks') })
    expect(store.list()).toEqual({ tasks: [], corrupted: [] })
  })

  it('get 不存在 / 损坏 → undefined', () => {
    const { tasksDir, store } = tempStore()
    expect(store.get('nope')).toBeUndefined()
    writeFileSync(join(tasksDir, 'bad.json'), 'x', 'utf8')
    expect(store.get('bad')).toBeUndefined()
  })

  it('save 结构非法 → 抛错且不落盘', () => {
    const { tasksDir, store } = tempStore()
    expect(() => store.save({ ...TASK, enabled: 1 } as unknown as TaskDef)).toThrow(TaskStoreError)
    expect(existsSync(join(tasksDir, 'demo.json'))).toBe(false)
  })

  it('remove 删除文件；重复删除返回 false', () => {
    const { tasksDir, store } = tempStore()
    store.save(TASK)
    expect(store.remove('demo')).toBe(true)
    expect(existsSync(join(tasksDir, 'demo.json'))).toBe(false)
    expect(store.remove('demo')).toBe(false)
  })
})

describe('list · 文件内 id 与文件名一致性', () => {
  it('文件名与 id 不一致 → 归入 corrupted 并 warn，不进入 tasks', () => {
    const warnings: string[] = []
    const { tasksDir, store } = tempStore({ logger: (message) => warnings.push(message) })
    writeFileSync(join(tasksDir, 'a.json'), `${JSON.stringify(TASK, null, 2)}\n`, 'utf8')
    writeFileSync(join(tasksDir, 'demo.json'), `${JSON.stringify(TASK, null, 2)}\n`, 'utf8')

    const listed = store.list()
    expect(listed.tasks.map((task) => task.id)).toEqual(['demo'])
    expect(listed.corrupted).toEqual(['a'])
    expect(warnings.join('\n')).toMatch(/与文件名/)
  })

  it('文件名与 id 一致 → 正常进入 tasks，corrupted 为空且不 warn', () => {
    const warnings: string[] = []
    const { tasksDir, store } = tempStore({ logger: { warn: (message) => warnings.push(message) } })
    writeFileSync(join(tasksDir, 'demo.json'), `${JSON.stringify(TASK, null, 2)}\n`, 'utf8')

    const listed = store.list()
    expect(listed.tasks.map((task) => task.id)).toEqual(['demo'])
    expect(listed.corrupted).toEqual([])
    expect(warnings).toEqual([])
  })

  it('结构非法与 id 不一致同时存在 → 全部计入 corrupted', () => {
    const { tasksDir, store } = tempStore()
    writeFileSync(join(tasksDir, 'broken.json'), '{ not json', 'utf8')
    writeFileSync(join(tasksDir, 'other.json'), `${JSON.stringify(TASK, null, 2)}\n`, 'utf8')

    const listed = store.list()
    expect(listed.tasks).toEqual([])
    expect(listed.corrupted.sort()).toEqual(['broken', 'other'])
  })
})

describe('原子写', () => {
  it('save 后目录只有 <id>.json，无 .tmp 残留', () => {
    const { tasksDir, store } = tempStore()
    store.save(TASK)
    store.save({ ...TASK, name: '改名' })
    expect(readdirSync(tasksDir)).toEqual(['demo.json'])
    expect(readFileSync(join(tasksDir, 'demo.json'), 'utf8')).toContain('改名')
  })

  it('写失败：抛 TaskStoreError、原文件不变、无 tmp 残留', (ctx) => {
    const { tasksDir, store } = tempStore()
    store.save(TASK)
    const before = readFileSync(join(tasksDir, 'demo.json'), 'utf8')

    // 目录只读 → 无法创建临时文件。root 下 chmod 不生效，直接跳过。
    const blocked = (() => {
      chmodSync(tasksDir, 0o500)
      try {
        writeFileSync(join(tasksDir, 'probe'), 'x', 'utf8')
        rmSync(join(tasksDir, 'probe'), { force: true })
        chmodSync(tasksDir, 0o700)
        return false
      } catch {
        chmodSync(tasksDir, 0o700)
        return true
      }
    })()
    if (!blocked) ctx.skip()

    chmodSync(tasksDir, 0o500)
    try {
      expect(() => store.save({ ...TASK, name: 'changed' })).toThrow(TaskStoreError)
    } finally {
      chmodSync(tasksDir, 0o700)
    }

    expect(readFileSync(join(tasksDir, 'demo.json'), 'utf8')).toBe(before)
    expect(readdirSync(tasksDir).filter((entry) => entry.includes('.tmp'))).toEqual([])
  })
})
