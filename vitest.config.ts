import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Windows validation exhausted browser teardown budgets when every logical CPU launched a worker.
    // Bound concurrent Chrome/ffmpeg/SQLite fixtures on 16 GiB hosts; keep each assertion and hook budget.
    maxWorkers: process.platform === 'win32' ? 4 : undefined,
    include: ['{apps,services,packages}/**/src/**/*.test.ts'],
    // Hosted runners have two CPUs, and some gateway tests make hundreds of real RPCs; local runs keep the default.
    testTimeout: process.env.CI ? 20_000 : 5_000,
  },
})
