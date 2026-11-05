/**
 * 任务程序校验（L1 形态 / L2 存在性可读性）。
 *
 * 全部在临时目录内进行；不可读场景用注入 fs，避免依赖执行用户权限
 * （CI 以 root 运行时 chmod 000 不生效）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_SCRIPT_EXTENSIONS,
  TaskPathError,
  resolveScriptPath,
  validateScript,
  validateScriptFile,
  validateScriptShape,
} from '../src/scheduler/validate.js'

const roots: string[] = []

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-base-validate-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

/** 断言抛出的是带指定 failureKind 的 TaskPathError，且信息含片段。 */
function expectPathError(run: () => unknown, failureKind: 'missing' | 'runtime', includes: string[]): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(TaskPathError)
    const pathError = error as TaskPathError
    expect(pathError.failureKind).toBe(failureKind)
    for (const part of includes) expect(pathError.message).toContain(part)
    return
  }
  throw new Error('预期抛出 TaskPathError，但没有抛错')
}

describe('常量与路径解析', () => {
  it('扩展名白名单为 js/mjs/cjs/ts', () => {
    expect([...ALLOWED_SCRIPT_EXTENSIONS]).toEqual(['.js', '.mjs', '.cjs', '.ts'])
  })

  it('相对路径按 workspace 解析为绝对路径', () => {
    const root = workspace()
    expect(resolveScriptPath(root, 'scripts/job.mjs')).toBe(join(root, 'scripts', 'job.mjs'))
  })

  it('绝对路径原样返回（不做 workspace 归属限制）', () => {
    const root = workspace()
    const abs = join(root, '..', 'outside.js')
    expect(resolveScriptPath('/some/workspace', abs)).toBe(abs)
  })

  it('解析不要求文件存在', () => {
    const root = workspace()
    expect(resolveScriptPath(root, 'nope.ts')).toBe(join(root, 'nope.ts'))
  })
})

describe('L1 · 形态校验', () => {
  it('合法扩展名通过并返回归一化小写扩展名', () => {
    expect(validateScriptShape('job.js')).toBe('.js')
    expect(validateScriptShape('job.mjs')).toBe('.mjs')
    expect(validateScriptShape('job.cjs')).toBe('.cjs')
    expect(validateScriptShape('job.ts')).toBe('.ts')
    expect(validateScriptShape('JOB.MJS')).toBe('.mjs')
  })

  it('空串 / 纯空白被拒（runtime）', () => {
    expectPathError(() => validateScriptShape(''), 'runtime', ['不能为空'])
    expectPathError(() => validateScriptShape('   '), 'runtime', ['不能为空'])
  })

  it('NUL 被拒（runtime）', () => {
    expectPathError(() => validateScriptShape('bad\0.js'), 'runtime', ['控制字符'])
  })

  it('控制字符（换行 / DEL）被拒（runtime）', () => {
    expectPathError(() => validateScriptShape('bad\n.js'), 'runtime', ['控制字符'])
    expectPathError(() => validateScriptShape('bad\u007f.js'), 'runtime', ['控制字符'])
  })

  it('无扩展名被拒（runtime）', () => {
    expectPathError(() => validateScriptShape('scripts/job'), 'runtime', ['缺少扩展名'])
  })

  it('非法扩展名 .py / .txt 被拒（runtime）', () => {
    expectPathError(() => validateScriptShape('job.py'), 'runtime', ['.py', '不受支持'])
    expectPathError(() => validateScriptShape('job.txt'), 'runtime', ['.txt', '不受支持'])
  })

  it('失败分类恒为 runtime', () => {
    try {
      validateScriptShape('job.py')
    } catch (error) {
      expect((error as TaskPathError).failureKind).toBe('runtime')
    }
  })
})

describe('L2 · 存在性 / 可读性', () => {
  it('文件不存在 → missing，信息含绝对路径与 not found', async () => {
    const root = workspace()
    const abs = join(root, 'missing.js')
    await expect(validateScriptFile(abs)).rejects.toMatchObject({ failureKind: 'missing' })
    await expect(validateScriptFile(abs)).rejects.toThrow(/not found/)
    await expect(validateScriptFile(abs)).rejects.toThrow(abs)
  })

  it('目录 → missing，信息含绝对路径与 not a file', async () => {
    const root = workspace({ 'adir/keep.txt': 'x' })
    const abs = join(root, 'adir')
    await expect(validateScriptFile(abs)).rejects.toThrow(/not a file/)
    await expect(validateScriptFile(abs)).rejects.toThrow(abs)
  })

  it('注入 fs 模拟不可读 → missing，信息含绝对路径与 not readable', async () => {
    const fs = {
      stat: async () => ({ isFile: () => true }),
      access: async () => {
        const error = new Error('EACCES: permission denied')
        ;(error as NodeJS.ErrnoException).code = 'EACCES'
        throw error
      },
    }
    const abs = '/virtual/workspace/job.js'
    await expect(validateScriptFile(abs, { fs })).rejects.toMatchObject({ failureKind: 'missing' })
    await expect(validateScriptFile(abs, { fs })).rejects.toThrow(/not readable/)
    await expect(validateScriptFile(abs, { fs })).rejects.toThrow(abs)
  })

  it('注入 fs：stat 与 access(R_OK) 都收到解析后的绝对路径', async () => {
    const calls: string[] = []
    const fs = {
      stat: async (path: string) => {
        calls.push(`stat:${path}`)
        return { isFile: () => true }
      },
      access: async (path: string, mode: number) => {
        calls.push(`access:${path}:${mode}`)
      },
    }
    const abs = '/virtual/workspace/job.js'
    await validateScriptFile(abs, { fs })
    expect(calls).toEqual([
      `stat:${abs}`,
      `access:${abs}:${4}`, // node:fs constants.R_OK === 4
    ])
  })

  it('stat 的其它错误（EACCES）也归入 missing 并带错误码', async () => {
    const fs = {
      stat: async () => {
        const error = new Error('permission denied')
        ;(error as NodeJS.ErrnoException).code = 'EACCES'
        throw error
      },
      access: async () => {},
    }
    await expect(validateScriptFile('/virtual/x.js', { fs })).rejects.toThrow(/EACCES/)
  })
})

describe('组合入口 validateScript', () => {
  it('相对路径：解析绝对路径、校验可读并返回 node 运行时', async () => {
    const root = workspace({ 'scripts/job.mjs': 'console.log(1)' })
    const result = await validateScript(root, 'scripts/job.mjs')
    expect(result).toEqual({
      path: join(root, 'scripts', 'job.mjs'),
      extension: '.mjs',
      runtime: 'node',
    })
  })

  it('绝对路径同样通过', async () => {
    const root = workspace({ 'job.ts': 'export {}' })
    const abs = join(root, 'job.ts')
    const result = await validateScript('/unused', abs)
    expect(result.path).toBe(abs)
    expect(result.extension).toBe('.ts')
  })

  it('不做语法解析：语法错误文件仍通过 L1 / L2', async () => {
    const root = workspace({ 'broken.js': 'this is not valid javascript {{{' })
    await expect(validateScript(root, 'broken.js')).resolves.toMatchObject({
      extension: '.js',
      runtime: 'node',
    })
  })

  it('缺文件时错误信息含解析后的绝对路径', async () => {
    const root = workspace()
    const abs = join(root, 'scripts', 'ghost.js')
    await expect(validateScript(root, 'scripts/ghost.js')).rejects.toThrow(abs)
    await expect(validateScript(root, 'scripts/ghost.js')).rejects.toMatchObject({
      failureKind: 'missing',
    })
  })

  it('非法扩展名在触碰文件系统前就被拒（runtime）', async () => {
    const root = workspace({ 'job.py': 'print(1)' })
    await expect(validateScript(root, 'job.py')).rejects.toMatchObject({
      failureKind: 'runtime',
    })
  })

  it('L1 先于 L2：不存在的 .py 报 runtime 而不是 missing', async () => {
    const root = workspace()
    await expect(validateScript(root, 'ghost.py')).rejects.toMatchObject({
      failureKind: 'runtime',
    })
  })
})
