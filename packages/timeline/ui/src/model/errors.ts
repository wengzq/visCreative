/** Both RPC links report connection loss as unavailable; unknown failures are not safe to retry. */
export function retryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const failure = error as { code?: unknown; data?: { code?: unknown } }
  const code = failure.data?.code ?? failure.code
  return code === 'unavailable' || code === 'timeout'
}
