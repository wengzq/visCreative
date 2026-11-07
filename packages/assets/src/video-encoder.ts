// 0024: H.264 encoder chosen once per ffmpeg binary (encoders.ts) and consumed by the timeline renderer.
// Packaged builds are LGPL without libx264, so the choice is probed at runtime, never assumed.
export type VideoEncoder = {
  /** ffmpeg encoder name, e.g. h264_nvenc, libx264, libopenh264 */
  name: string
  /** Encoder options placed after `-c:v <name>` (quality, rate control, pixel format) */
  args: string[]
  /** Options placed before the inputs, e.g. a VAAPI device */
  inputArgs?: string[]
  /** Filter appended to the final video chain, e.g. `format=nv12,hwupload` for VAAPI */
  filter?: string
  hardware: boolean
}
