import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Each file starts studiod and Chrome. Private CI runners have two CPUs: two concurrent files still failed different tests on every run.
  // Only CI's whole-test budget grows for this real work; assertion waits and the local budget stay unchanged.
  test: {
    include: ['e2e/**/*.e2e.ts'], hookTimeout: 30_000,
    testTimeout: process.env.CI ? 40_000 : 20_000, maxWorkers: process.env.CI ? 1 : 4,
  },
})
