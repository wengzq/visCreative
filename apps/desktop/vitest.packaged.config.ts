import { defineConfig } from 'vitest/config'

// Separate acceptance gate: requires an already packaged desktop app, never a real Agent or generation provider.
export default defineConfig({
  test: { include: ['e2e/packaged.e2e.ts'], hookTimeout: 45_000, testTimeout: 120_000, maxWorkers: 1 },
})
