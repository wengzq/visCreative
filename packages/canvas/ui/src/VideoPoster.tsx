import { useState } from 'react'
import type { CSSProperties, ReactEventHandler } from 'react'

/** Hosts without poster support and failed poster requests retain the video thumbnail. */
export function VideoPoster({ src, posterSrc, className, style, onLoad, onError, onLoadedMetadata }: {
  src: string
  posterSrc?: string
  className?: string
  style?: CSSProperties
  onLoad?(): void
  onError?(): void
  onLoadedMetadata?: ReactEventHandler<HTMLVideoElement>
}) {
  const [failed, setFailed] = useState<string | null>(null)
  return posterSrc && failed !== posterSrc
    ? <img src={posterSrc} className={className} style={style} alt="" draggable={false} onLoad={onLoad} onError={() => setFailed(posterSrc)} />
    : <video src={`${src}#t=0.001`} className={className} style={style} preload="metadata" muted playsInline onLoadedData={onLoad} onError={onError} onLoadedMetadata={onLoadedMetadata} />
}
