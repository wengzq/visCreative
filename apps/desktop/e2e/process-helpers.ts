export function selectStudiodPid(output: string, matches: (pid: number) => boolean): number | undefined {
  const pids = [...new Set(output.trim().split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number))]
    .filter(pid => pid > 0 && Number.isSafeInteger(pid) && matches(pid))
  if (pids.length > 1) throw new Error('Multiple studiod processes match the isolated test lock')
  return pids[0]
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Test studiod shutdown timed out')), timeoutMs)
    })])
  } finally { clearTimeout(timer!) }
}

export async function cleanupStudiod(options: {
  shutdown(): Promise<void>
  waitForExit(): Promise<void>
  alive(): boolean
  terminate(signal: NodeJS.Signals): void
  remove(): void
  shutdownTimeoutMs?: number
}) {
  try {
    await deadline(options.shutdown(), options.shutdownTimeoutMs ?? 5000)
    await options.waitForExit()
  } finally {
    try {
      if (options.alive()) {
        options.terminate('SIGTERM')
        try { await options.waitForExit() } catch {
          if (options.alive()) {
            options.terminate('SIGKILL')
            await options.waitForExit()
          }
        }
      }
    } finally {
      // Preserve data for inspection if even the last-resort stop failed; never delete an open database.
      if (!options.alive()) options.remove()
    }
  }
}
