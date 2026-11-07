/** WebM signals alpha in a tag even when ffprobe reports the native decoder's yuv420p. */
export type AlphaStream = { codec_name?: string; pix_fmt?: string; tags?: Record<string, string> }
export function streamHasAlpha(stream: AlphaStream): boolean {
  return /^(?:yuva|gbrap|rgba|bgra|argb|abgr|ya\d)/.test(stream.pix_fmt ?? '')
    || Object.entries(stream.tags ?? {}).some(([key, value]) => key.toLowerCase() === 'alpha_mode' && value === '1')
}

/** The native VP9 decoder discards the alpha side stream. This is an input option, before -i. */
export function alphaDecoder(stream: AlphaStream): string[] {
  return stream.codec_name === 'vp9' && streamHasAlpha(stream) ? ['-c:v', 'libvpx-vp9'] : []
}
