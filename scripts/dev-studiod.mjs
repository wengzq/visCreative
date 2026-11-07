// Start studiod for development: data goes in ~/.vis-dev (overridable with VIS_DATA_DIR), and vis uses the repository build.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const env = {
  ...process.env,
  VIS_DATA_DIR: process.env.VIS_DATA_DIR ?? join(homedir(), '.vis-dev'),
  VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'),
}
console.log(`[dev] Data directory ${env.VIS_DATA_DIR}`)
const child = spawn(process.execPath, [join(root, 'services/studiod/dist/studiod.mjs')], { env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => process.exit(code ?? 0))
