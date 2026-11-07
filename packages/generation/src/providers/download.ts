import { ProviderError } from './types'

export class OutputSizeLimitError extends ProviderError {
  constructor() {
    super('rejected', 'Generation output exceeds the size limit')
  }
}

/** Enforce the bound while streaming, including responses without Content-Length. */
export async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new OutputSizeLimitError()
  }
  const chunks: Uint8Array[] = []
  const reader = response.body?.getReader()
  let size = 0
  if (!reader) throw new ProviderError('rejected', 'Generation output is empty')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new OutputSizeLimitError()
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
