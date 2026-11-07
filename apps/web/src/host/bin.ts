import { studiodEndpoint } from '../../../../runtime/studiod-endpoint'
// Local web UI entry point. Requires studiod to be running with the same VIS_DATA_DIR (default ~/.vis-dev).
//   VIS_WEB_PORT  Optional fixed port; random by default
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWebHost } from './server'

const dataDir = process.env.VIS_DATA_DIR ?? join(homedir(), '.vis-dev')
const run = join(dataDir, 'run')
const host = await createWebHost({
  socketPath: studiodEndpoint(dataDir),
  tokenPath: join(run, 'studiod.token'),
  // After bundling, client/ sits alongside dist/vis-web.mjs
  staticDir: fileURLToPath(new URL('./client/', import.meta.url)),
  ...(process.env.VIS_WEB_PORT ? { port: Number(process.env.VIS_WEB_PORT) } : {}),
})
console.log(`[web] Data directory ${dataDir}`)
console.log(`[web] Open in browser: ${host.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void host.close().then(() => process.exit(0)) })
