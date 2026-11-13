/**
 * The window only ever shows the in-process web host (RFC 0046). Other web links go to the system browser, and
 * anything else (file:, javascript:, custom schemes) is dropped.
 */
export function navigationTarget(url: string, appOrigin: string): 'app' | 'external' | 'deny' {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'deny'
  }
  if (parsed.origin === appOrigin) return 'app'
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? 'external' : 'deny'
}

// Copying text is the only browser permission the UI needs; everything else (camera, microphone, location, notifications…) is refused.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

export function permissionAllowed(permission: string, requestingUrl: string, appOrigin: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && navigationTarget(requestingUrl, appOrigin) === 'app'
}
