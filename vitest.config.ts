import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置。
 *
 * 骨架期没有测试文件，`passWithNoTests` 保证测试集为空时也能成功退出。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    passWithNoTests: true,
  },
})
