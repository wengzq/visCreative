import { defineConfig } from 'vitest/config'

// Starts the real Electron app; needs `pnpm build` and the Electron binary, so it stays out of `pnpm check` and the web e2e suite.
export default defineConfig({
  test: { include: ['e2e/smoke.e2e.ts'], hookTimeout: 30_000, testTimeout: 90_000, maxWorkers: 1 },
})
