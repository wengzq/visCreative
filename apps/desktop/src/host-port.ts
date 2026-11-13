import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Keep the web host on the same loopback port across launches. The UI stores its preferences (language, last project,
 * panel sizes) in localStorage, which belongs to the origin, so a new random port each launch would reset them.
 * If the remembered port is taken this launch falls back to a random one and keeps the remembered port for next time.
 */
export async function startOnStablePort<T extends { port: number }>(file: string, start: (port?: number) => Promise<T>): Promise<T> {
  let remembered: number | undefined
  try {
    const value = Number(readFileSync(file, 'utf8').trim())
    if (Number.isInteger(value) && value >= 1024 && value <= 65535) remembered = value
  } catch { /* first launch */ }
  if (remembered !== undefined) {
    try {
      return await start(remembered)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
      return start()
    }
  }
  const host = await start()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${host.port}\n`)
  } catch { /* preferences reset next launch; not worth failing the start */ }
  return host
}
