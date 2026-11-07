import { defineConfig } from 'vitest/config'

// Deliberately separate from unit tests and e2e: captures use an isolated stack and local rendering.
export default defineConfig({
  test: { include: ['readme-shots/**/*.shots.ts'], testTimeout: 600_000, hookTimeout: 600_000, fileParallelism: false, maxWorkers: 1 },
})
