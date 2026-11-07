import { defineConfig } from 'vitest/config'

// RFC 0024 §8 performance harness. Measures only, never fails on a number, and stays out of pnpm check and e2e.
// One file at a time so measurements never share the machine with another suite.
export default defineConfig({
  test: { include: ['perf/**/*.perf.ts'], testTimeout: 600_000, hookTimeout: 600_000, fileParallelism: false, maxWorkers: 1 },
})
