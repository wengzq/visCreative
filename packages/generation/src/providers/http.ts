import { endpointOverrideValid, ProviderBaseUrl, type MediaKind } from '@vis/protocol'
import { ProviderError } from './types'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function redact(value: string, key: string): string {
  let safe = value
  for (const secret of new Set([key, encodeURIComponent(key)])) safe = safe.split(secret).join('[REDACTED]')
  return safe.replace(/["']?authorization["']?\s*[:=]\s*["']?[^"'\r\n,;}]+["']?/gi, 'Authorization: [REDACTED]')
    .replace(/\bBearer\s+[^\s"'<>\\,;]+/gi, 'Bearer [REDACTED]')
}

export function containsKey(value: string, key: string): boolean {
  return value.includes(key) || value.includes(encodeURIComponent(key))
}

/** Repeats config validation so a directly built adapter cannot send a key to an unsafe URL; a stored region must keep its listed host. */
export function providerEndpoint(value: string | undefined, regions: readonly { id: string; baseUrl: string }[], region: string | undefined, message: string): string {
  const baseUrl = value?.replace(/\/+$/, '') ?? ''
  if (!ProviderBaseUrl.safeParse(baseUrl).success || (region !== undefined && regions.find(entry => entry.id === region)?.baseUrl !== baseUrl)) {
    throw new ProviderError('rejected', message)
  }
  return baseUrl
}

/** requiredFor marks paths a paid job cannot finish without, so a missing one is refused at save time rather than after the charge. */
export type ProviderEndpoint = { id: string; label: Record<'zh' | 'en', string>; path: string; requiredFor?: readonly MediaKind[] }

/**
 * Resolve declared API paths; overrides repeat the config check so a directly built adapter cannot leave its base URL.
 * Without overrides the declared paths apply. With them, an unset path means the base URL itself: we cannot assume a vendor's layout.
 */
export function providerPaths<const T extends readonly ProviderEndpoint[]>(endpoints: T, overrides: Record<string, string> | undefined, message: string) {
  for (const [id, path] of Object.entries(overrides ?? {})) {
    const declared = endpoints.find(endpoint => endpoint.id === id)
    if (!declared || !endpointOverrideValid(declared.path, path)) throw new ProviderError('rejected', message)
  }
  const declared = (id: string) => endpoints.find(endpoint => endpoint.id === id)!.path
  const pathOf = (id: string) => overrides === undefined ? declared(id) : overrides[id] ?? ''
  const resolve = (id: T[number]['id'], values: { model?: string; id?: string } = {}) => {
    const path = pathOf(id)
    // The base URL alone cannot carry a model or task ID, so stop before the request.
    if (!path && declared(id).includes('{')) throw new ProviderError('rejected', message, 'generation.provider_endpoint_missing')
    return path.replace(/\{(model|id)\}/g, (_, name: 'model' | 'id') => encodeURIComponent(values[name] ?? ''))
  }
  return Object.assign(resolve, { configured: (id: T[number]['id']) => Boolean(pathOf(id)) })
}

/** Keep URL syntax validation separate from each adapter's credential policy. */
export function outputUrl(value: string, message: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    return url.href
  } catch {
    throw new ProviderError('rejected', message)
  }
}
