import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { VisError } from '@vis/domain'
import { tool } from './media'
import type { VideoEncoder } from './video-encoder'

const run = promisify(execFile)

export type EncoderRunner = (executable: string, args: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string }>

export const SOFTWARE_FIRST_H264_ENCODERS = ['libx264', 'h264_videotoolbox', 'libopenh264'] as const

const execute: EncoderRunner = (executable, args, opts) => run(executable, args, {
  timeout: opts.timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024,
})

const hardware: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'],
  darwin: ['h264_videotoolbox'],
  linux: ['h264_vaapi'],
}

const profiles: Record<string, VideoEncoder> = {
  h264_nvenc: { name: 'h264_nvenc', hardware: true, args: ['-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-pix_fmt', 'yuv420p'] },
  h264_qsv: { name: 'h264_qsv', hardware: true, args: ['-preset', 'veryfast', '-global_quality', '20', '-pix_fmt', 'nv12'] },
  h264_amf: { name: 'h264_amf', hardware: true, args: ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '20', '-pix_fmt', 'nv12'] },
  h264_mf: { name: 'h264_mf', hardware: true, args: ['-hw_encoding', '1', '-b:v', '8M', '-pix_fmt', 'nv12'] },
  h264_videotoolbox: { name: 'h264_videotoolbox', hardware: true, args: ['-allow_sw', '0', '-b:v', '8M', '-pix_fmt', 'yuv420p'] },
  h264_vaapi: { name: 'h264_vaapi', hardware: true, inputArgs: ['-vaapi_device', '/dev/dri/renderD128'], filter: 'format=nv12,hwupload', args: ['-rc_mode', 'CQP', '-qp', '20'] },
  libx264: { name: 'libx264', hardware: false, args: ['-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'] },
  // OpenH264 has no CRF; a bounded 8 Mbps target is practical for 1080p delivery.
  libopenh264: { name: 'libopenh264', hardware: false, args: ['-b:v', '8M', '-maxrate', '12M', '-pix_fmt', 'yuv420p'] },
}

const detections = new Map<string, Promise<VideoEncoder>>()

/** Cache the trial as well as its result so simultaneous exports never probe twice. */
export function detectVideoEncoder(opts: { ffmpegPath?: string; platform?: NodeJS.Platform; exec?: EncoderRunner; priority?: readonly string[] } = {}): Promise<VideoEncoder> {
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg'
  const key = JSON.stringify([ffmpeg, opts.priority ?? null])
  const existing = detections.get(key)
  if (existing) return existing
  const detection = detect(ffmpeg, opts.platform ?? process.platform, opts.exec ?? execute, opts.priority).catch(error => {
    if (detections.get(key) === detection) detections.delete(key)
    throw error
  })
  detections.set(key, detection)
  return detection
}

async function detect(ffmpeg: string, platform: NodeJS.Platform, exec: EncoderRunner, priority?: readonly string[]): Promise<VideoEncoder> {
  let detail = ''
  try {
    const { stdout } = await exec(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 5000 })
    const listed = new Set([...stdout.matchAll(/^\s*V\S{5}\s+(\S+)/gm)].map(match => match[1]))
    for (const name of priority ?? [...(hardware[platform] ?? []), 'libx264', 'libopenh264']) {
      const encoder = profiles[name]
      if (!listed.has(name) || !encoder) continue
      try {
        await exec(ffmpeg, [
          '-hide_banner', '-v', 'error', '-nostdin', ...(encoder.inputArgs ?? []),
          // Hardware encoders reject tiny frames (NVENC: 'Frame Dimension less than the minimum'), so a too-small trial would skip a working GPU
          '-f', 'lavfi', '-i', 'color=black:size=256x256:rate=30',
          '-frames:v', '1', ...(encoder.filter ? ['-vf', encoder.filter] : []),
          '-c:v', encoder.name, ...encoder.args, '-f', 'null', '-',
        ], { timeoutMs: 5000 })
        return { ...encoder, args: [...encoder.args], ...(encoder.inputArgs ? { inputArgs: [...encoder.inputArgs] } : {}) }
      } catch (error) { detail = tool(error, ffmpeg) }
    }
  } catch (error) { detail = tool(error, ffmpeg) }
  throw VisError.of('unavailable', 'media.encoder_missing', { detail }, 'No usable H.264 encoder was found. Install or update ffmpeg')
}
