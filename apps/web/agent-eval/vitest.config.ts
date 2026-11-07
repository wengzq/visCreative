import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['agent-eval/**/*.eval-test.ts'], fileParallelism: false },
})
