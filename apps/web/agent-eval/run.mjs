import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Bundle the host link and protocol exactly as the web host does, without adding a TS runtime dependency.
const temporary = await mkdtemp(join(tmpdir(), 'vis-agent-eval-code-'))
try {
  const entry = join(temporary, 'runner.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('./runner.ts', import.meta.url))], outfile: entry,
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  const { main } = await import(pathToFileURL(entry).href)
  await main(process.argv.slice(2), fileURLToPath(new URL('../../../', import.meta.url)))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await rm(temporary, { recursive: true, force: true })
}
