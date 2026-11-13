#!/usr/bin/env node
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { isSystemLibrary, linkedLibraries, rpaths, run, sha256 } from './common.mjs'

const directory = process.argv[2]
if (process.argv.length !== 3 || !directory) throw new Error('Usage: node scripts/ffmpeg/verify.mjs <darwin-arm64-or-x64-directory>')
if (process.platform !== 'darwin') throw new Error('Verification requires macOS (otool, lipo, codesign and VideoToolbox)')
const requirements = JSON.parse(await readFile(new URL('./requirements.json', import.meta.url), 'utf8'))
const dir = resolve(directory)
const info = JSON.parse(await readFile(join(dir, 'BUILDINFO.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'vis-ffmpeg-verify-'))
// A parent process must not make an accidentally non-relocatable bundle appear to work.
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('DYLD_')) delete env[key]
function tool(bundle, name, args, options = {}) {
  return run(join(bundle, name), args, { env, ...options })
}
function ff(bundle, args, options) {
  return tool(bundle, 'ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-y', ...args], options)
}
function probe(bundle, path) {
  return JSON.parse(tool(bundle, 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]))
}
async function inspect(bundle) {
  const configuration = tool(bundle, 'ffmpeg', ['-buildconf'])
  assert(!/--enable-(?:gpl|nonfree|version3)(?:\s|$)/.test(configuration), 'Forbidden licence flag')
  assert(configuration.includes('--enable-shared'), 'Shared FFmpeg libraries are required')
  assert.match(tool(bundle, 'ffmpeg', ['-L']).replace(/\s+/g, ' '), /GNU Lesser General Public License/)
  assert.match(tool(bundle, 'ffmpeg', ['-version']), new RegExp(`ffmpeg version ${info.sources.find(item => item.id === 'ffmpeg').version.replaceAll('.', '\\.')}`))
  const names = await readdir(bundle)
  const binaries = names.filter(name => name === 'ffmpeg' || name === 'ffprobe' || name.endsWith('.dylib'))
  for (const name of binaries) {
    const path = join(bundle, name)
    assert.equal(run('lipo', ['-archs', path]).trim(), info.arch === 'x64' ? 'x86_64' : 'arm64')
    run('codesign', ['--verify', path])
    for (const lib of linkedLibraries(path)) {
      assert(isSystemLibrary(lib) || lib.startsWith('@loader_path/') || lib.startsWith('@rpath/'), `${name}: forbidden dependency ${lib}`)
      if (lib.startsWith('@')) {
        assert.equal(lib.split('/').length, 2, `${name}: dependency escapes the flat bundle`)
        assert(names.includes(basename(lib)), `${name}: missing ${lib}`)
      }
    }
    for (const searchPath of rpaths(path)) assert.equal(searchPath, '@loader_path', `${name}: nonportable rpath`)
  }
  for (const [kind, needed] of Object.entries(requirements)) {
    const listing = tool(bundle, 'ffmpeg', ['-hide_banner', `-${kind}`])
    const names = new Set(listing.split(/\s+/).flatMap(name => [name, ...name.split(',')]))
    for (const name of needed) assert(names.has(name), `Missing ${kind}: ${name}`)
  }
  assert.match(tool(bundle, 'ffmpeg', ['-hide_banner', '-devices']), /lavfi/)
  console.log(`PASS licence, architecture, ${binaries.length} Mach-O files, dependency closure and media requirements`)
}
async function functional(bundle, label) {
  const cwd = join(temporary, label)
  await mkdir(cwd)
  const args = ['-f', 'lavfi', '-i', 'testsrc2=s=256x256:r=10:d=0.6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6']
  for (const encoder of ['h264_videotoolbox', 'libopenh264']) {
    const output = join(cwd, `${encoder}.mp4`)
    ff(bundle, [...args, '-c:v', encoder, ...(encoder === 'h264_videotoolbox' ? ['-allow_sw', '0'] : []), '-b:v', '1M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', output])
    const streams = probe(bundle, output).streams
    assert(streams.some(stream => stream.codec_name === 'h264'))
    assert(streams.some(stream => stream.codec_name === 'aac' && stream.channels === 2))
    ff(bundle, ['-i', output, '-vf', 'fps=5,scale=-2:64,setsar=1,tile=3x1', '-frames:v', '1', join(cwd, `${encoder}.jpg`)])
    ff(bundle, ['-i', output, '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', join(cwd, `${encoder}.wav`)])
  }
  console.log(`PASS ${label}: hardware-only VideoToolbox, OpenH264 fallback, AAC, JPEG filmstrip and PCM waveform`)
  await writeFile(join(cwd, 'captions.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 256\nPlayResY: 256\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Caption 123\n')
  const picture = ['-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=10:d=0.6']
  const pixels = ff(bundle, [...picture, '-vf', 'ass=captions.ass', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { cwd, encoding: null })
  assert(pixels.some(value => value > 100), 'ASS captions must change black pixels')
  await writeFile(join(cwd, 'filter.txt'), '[0:v]split[a][b];[a]trim=duration=0.3,setpts=PTS-STARTPTS,scale=128:128,pad=256:256:64:64,fps=10,setsar=1,settb=AVTB[x];[b]trim=start=0.3,setpts=PTS-STARTPTS,fps=10,settb=AVTB[y];[x][y]xfade=transition=fade:duration=0.1:offset=0.2,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.1,trim=duration=0.5,ass=captions.ass[v];[1:a]atrim=duration=0.5,asetpts=PTS-STARTPTS,atempo=1.25,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.5,afade=t=in:d=0.1,adelay=10:all=1,apad[a];anullsrc=r=48000:cl=stereo,atrim=duration=0.5[s];[s][a]amix=inputs=2:normalize=0,alimiter=level=0:latency=1,atrim=duration=0.5[out]\n')
  ff(bundle, [...args, '-/filter_complex', 'filter.txt', '-map', '[v]', '-map', '[out]', '-c:v', 'libopenh264', '-b:v', '1M', '-c:a', 'aac', '-t', '0.5', 'timeline.mp4'], { cwd })
  await writeFile(join(cwd, 'list.txt'), "file 'timeline.mp4'\nfile 'timeline.mp4'\n")
  ff(bundle, ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', 'concat.mp4'], { cwd })
  ff(bundle, ['-i', join(cwd, 'concat.mp4'), '-af', 'silencedetect=noise=-35dB:d=0.1', '-f', 'null', '-'])
  console.log(`PASS ${label}: ASS pixels, file-based timeline filter graph, transitions, audio mixing, concat stream copy and silence analysis`)
  const alpha = join(cwd, 'alpha.webm')
  ff(bundle, ['-f', 'lavfi', '-i', 'color=red@0.5:s=256x256:r=4:d=0.5,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '18', '-auto-alt-ref', '0', alpha])
  const rgba = ff(bundle, ['-c:v', 'libvpx-vp9', '-i', alpha, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: null })
  assert(rgba[3] > 80 && rgba[3] < 180, 'VP9 alpha must survive encoding and decoding')
  const overlay = join(cwd, 'overlay.mp4')
  ff(bundle, ['-f', 'lavfi', '-i', 'color=blue:s=256x256:r=4:d=0.5', '-c:v', 'libvpx-vp9', '-i', alpha,
    '-filter_complex', '[0:v]null,format=yuv420p[base];[1:v]loop=loop=-1:size=1:start=0,setpts=N/(4*TB),fps=4,settb=AVTB,trim=duration=0.5,scale=64:64,format=yuva420p,colorchannelmixer=aa=0.5,fade=t=in:st=0:d=0.1:alpha=1,fade=t=out:st=0.4:d=0.1:alpha=1,tpad=stop_mode=clone:stop=1,transpose=1,hflip,vflip[logo];[base][logo]overlay=x=16:y=16:eof_action=pass,format=yuva420p,premultiply=inplace=1,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'libopenh264', '-b:v', '1M', '-t', '0.5', overlay])
  const mixed = ff(bundle, ['-ss', '0.25', '-i', overlay, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: null })
  const pixel = (32 * 256 + 32) * 3
  assert(mixed[pixel] > 20 && mixed[pixel + 2] > 20, 'The faded transparent overlay must blend red and blue pixels')
  const prores = join(cwd, 'prores.mov')
  ff(bundle, ['-c:v', 'libvpx-vp9', '-i', alpha, '-f', 'lavfi', '-i', 'sine=d=0.5', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-c:a', 'pcm_s24le', '-shortest', prores])
  assert(probe(bundle, prores).streams.some(stream => stream.codec_name === 'prores' && stream.profile === '4444'))
  ff(bundle, ['-i', prores, '-frames:v', '1', join(cwd, 'frame.png')])
  ff(bundle, ['-f', 'image2pipe', '-framerate', '4', '-i', 'pipe:0', '-c:v', 'libopenh264', '-b:v', '1M', '-pix_fmt', 'yuv420p', join(cwd, 'pipe.mp4')], { input: await readFile(join(cwd, 'frame.png')) })
  ff(bundle, ['-f', 'lavfi', '-i', 'testsrc=s=256x256:r=4:d=0.5', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', join(cwd, 'mpeg4.mp4')])
  assert(ff(bundle, ['-i', join(cwd, 'mpeg4.mp4'), '-f', 'framemd5', 'pipe:1']).includes('#codec_id 0: rawvideo'))
  ff(bundle, ['-i', overlay, '-map', '0:v:0', '-c', 'copy', '-f', 'h264', join(cwd, 'stream.h264')])
  ff(bundle, ['-f', 'lavfi', '-i', 'sine=d=0.5', '-c:a', 'libopus', join(cwd, 'audio.ogg')])
  ff(bundle, ['-i', join(cwd, 'audio.ogg'), '-c:a', 'flac', join(cwd, 'audio.flac')])
  ff(bundle, ['-i', join(cwd, 'audio.flac'), '-c:a', 'libmp3lame', join(cwd, 'audio.mp3')])
  assert(probe(bundle, join(cwd, 'audio.mp3')).streams.some(stream => stream.codec_name === 'mp3'))
  assert(ff(bundle, ['-i', join(cwd, 'audio.mp3'), '-vn', '-f', 'f32le', 'pipe:1'], { encoding: null }).length > 0)
  ff(bundle, ['-i', join(cwd, 'audio.flac'), '-c:a', 'aac_at', join(cwd, 'audio.m4a')])
  ff(bundle, ['-i', join(cwd, 'frame.png'), '-vf', 'crop=128:128:0:0,format=rgba,split[fg][bg];[bg]geq=r=190:g=190:b=190:a=255[checker];[checker][fg]overlay', '-frames:v', '1', join(cwd, 'poster.jpg')])
  console.log(`PASS ${label}: VP9 alpha/overlay pixels, ProRes 4444, PNG/image pipe, MPEG-4/frame hashes, H.264 stream copy, posters, MP3/Opus/FLAC and AudioToolbox AAC`)
}
try {
  for (const source of info.sources) {
    assert.equal(await sha256(join(dir, 'source', source.archive)), source.sha256, `Source archive mismatch: ${source.id}`)
    for (const file of source.licenseFiles) assert((await stat(join(dir, 'LICENSES', source.id, basename(file)))).size > 0)
  }
  console.log('PASS source archive checksums and dependency licence texts')
  await inspect(dir)
  await functional(dir, 'original')
  const relocated = join(temporary, 'different location', 'ffmpeg')
  await cp(dir, relocated, { recursive: true })
  await inspect(relocated)
  await functional(relocated, 'relocated')
  console.log(`PASS relocated bundle (${info.arch}); all checks passed`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
