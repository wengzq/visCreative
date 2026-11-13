import type { HostingConfig } from '@vis/protocol'

export function redactHostingText(text: string, config: HostingConfig | null): string {
  // Match raw, JSON-escaped and URL-encoded vendor echoes without retaining a request's URLs in memory.
  let safe = text.replace(/https?(?::|%(?:25)*3a)(?:\/|\\\/|%(?:25)*2f){2}(?:[a-z0-9-]+\.)*(?:tos-[a-z0-9-]+\.volces\.com|ivolces\.com)[^\s"'<>]*/gi, '[redacted]')
  safe = safe.replace(/(X-Tos-(?:Signature|Credential)(?:["']|%22)?\s*(?:=|:|%(?:25)*(?:3d|3a))\s*(?:["']|%22)?)[^&\s"'<>]+/gi, '$1[redacted]')
  // IAM documents AKLT followed by letters, digits, hyphens or underscores: https://docs.volcengine.com/docs/iam/access-key-meta-data?lang=zh
  safe = safe.replace(/AKLT[A-Za-z0-9_-]+/g, '[redacted]')
  if (config?.accessKeyId) {
    const encoded = encodeURIComponent(config.accessKeyId)
    for (const value of new Set([config.accessKeyId, encoded, encodeURIComponent(encoded)])) safe = safe.replaceAll(value, '[redacted]')
  }
  return safe
}
