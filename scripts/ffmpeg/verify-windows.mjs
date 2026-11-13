#!/usr/bin/env node
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run, sha256 } from './common.mjs'
import { assertImportClosure, peImports, windowsRequirements } from './windows.mjs'

const env = { ...process.env }
// Only the executable's directory and Windows may satisfy runtime DLL imports.
if (process.platform === 'win32') env.PATH = [join(process.env.SystemRoot ?? 'C:/Windows', 'System32'), process.env.SystemRoot ?? 'C:/Windows'].join(';')
function tool(bundle, name, args, options = {}) {
  return run(join(bundle, name + '.exe'), args, { env, timeout: 60_000, ...options })
}
function ff(bundle, args, options) {
  return tool(bundle, 'ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-y', ...args], options)
}
function probe(bundle, path) {
  return JSON.parse(tool(bundle, 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]))
}

export function inspectConfiguration(bundle, version) {
  const configuration = tool(bundle, 'ffmpeg', ['-buildconf'])
  const license = tool(bundle, 'ffmpeg', ['-L']).replace(/\s+/g, ' ')
  const release = tool(bundle, 'ffmpeg', ['-version'])
  const failures = []
  if (/--enable-(?:gpl|nonfree|version3)(?:\s|$)/.test(configuration)) failures.push('Forbidden licence flag')
  for (const flag of ['--enable-shared', '--disable-static', '--disable-autodetect', '--disable-gpl', '--disable-version3', '--disable-nonfree']) {
    if (!configuration.includes(flag)) failures.push(`Missing build flag: ${flag}`)
  }
  if (/--enable-libx26[45]/.test(configuration)) failures.push('GPL encoders are forbidden')
  if (!/GNU Lesser General Public License/.test(license)) failures.push('FFmpeg must report LGPL')
  if (!/\bversion 2\.1\b/.test(license)) failures.push('FFmpeg must report LGPL 2.1 or later; LGPLv3-only builds are forbidden')
  if (!new RegExp(`ffmpeg version ${version.replaceAll('.', '\\.')}(?:\\s|-)`).test(release)) failures.push(`Expected FFmpeg ${version}: ${release.split('\n')[0]}`)
  assert.equal(failures.length, 0, failures.join('; '))
  console.log('PASS licence, shared FFmpeg configuration and pinned version')
}

export async function inspectImports(bundle) {
  const names = await readdir(bundle)
  const binaries = names.filter(name => /^(?:ffmpeg|ffprobe)\.exe$/i.test(name) || /\.dll$/i.test(name))
  assert(names.includes('ffmpeg.exe') && names.includes('ffprobe.exe'), 'Both executables are required')
  const imports = {}
  for (const name of binaries) imports[name] = peImports(await readFile(join(bundle, name)))
  assertImportClosure(imports, binaries)
  assert(binaries.some(name => /^avcodec-\d+\.dll$/i.test(name)), 'Shared avcodec DLL is required')
  assert(binaries.some(name => /^avformat-\d+\.dll$/i.test(name)), 'Shared avformat DLL is required')
  console.log(`PASS x64 PE architecture and import closure for ${binaries.length} files`)
}

export async function inspectRequirements(bundle) {
  const shared = JSON.parse(await readFile(new URL('./requirements.json', import.meta.url), 'utf8'))
  const overrides = JSON.parse(await readFile(new URL('./requirements-windows.json', import.meta.url), 'utf8'))
  for (const [kind, needed] of Object.entries(windowsRequirements(shared, overrides))) {
    const listing = tool(bundle, 'ffmpeg', ['-hide_banner', `-${kind}`])
    const names = new Set(listing.split(/\s+/).flatMap(name => [name, ...name.split(',')]))
    for (const name of needed) assert(names.has(name), `Missing ${kind}: ${name}`)
  }
  assert.match(tool(bundle, 'ffmpeg', ['-hide_banner', '-devices']), /lavfi/)
  console.log('PASS all Windows media requirements and lavfi')
}

async function inspectSources(bundle) {
  const info = JSON.parse(await readFile(join(bundle, 'BUILDINFO.json'), 'utf8'))
  assert.equal(info.platform, 'win32')
  assert.equal(info.arch, 'x64')
  assert.equal(info.toolchain.cRuntime, 'msvcrt')
  assert(info.toolchain.packages.length > 0, 'Exact toolchain package versions are required')
  const pinned = (await Promise.all(['sources.json', 'sources-windows.json'].map(async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'))))).flat()
  assert.equal(new Set(info.sources.map(source => source.id)).size, info.sources.length, 'Duplicate source IDs')
  for (const source of pinned) assert.deepEqual(info.sources.find(item => item.id === source.id), source, `Pinned source identity: ${source.id}`)
  assert(info.sources.some(source => source.id.startsWith('toolchain-runtime-')), 'Toolchain runtime sources are required')
  for (const source of info.sources) {
    assert.equal(basename(source.archive), source.archive, 'Source archive must be a basename')
    assert.equal(await sha256(join(bundle, 'source', source.archive)), source.sha256, `Source archive mismatch: ${source.id}`)
    for (const file of source.licenseFiles) assert((await stat(join(bundle, 'LICENSES', source.id, basename(file)))).size > 0)
  }
  for (const name of ['build-ffmpeg-windows.mjs', 'ffmpeg/sources.json', 'ffmpeg/sources-windows.json', 'ffmpeg/common.mjs', 'ffmpeg/windows.mjs']) {
    assert((await stat(join(bundle, 'source/build-scripts/scripts', name))).size > 0, `Missing recipe: ${name}`)
  }
  assert((await readdir(join(bundle, 'LICENSES/toolchain-runtime'))).length >= 3, 'Toolchain copyright notices are required')
  console.log('PASS all pinned and toolchain source checksums, licences and exact recipes')
  return info
}

export async function functional(bundle, label, temporary) {
  const cwd = join(temporary, label)
  await mkdir(cwd)
  const args = ['-f', 'lavfi', '-i', 'testsrc2=s=256x256:r=10:d=0.6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6']
  for (const encoder of ['libopenh264', 'h264_mf']) {
    const output = join(cwd, `${encoder}.mp4`)
    try {
      ff(bundle, [...args, '-c:v', encoder, '-b:v', '1M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', output])
    } catch (error) {
      if (encoder !== 'h264_mf') throw error
      console.log(`SKIP ${label}: h264_mf is unavailable on this host: ${error.message.split('\n').slice(-3).join(' ')}`)
      continue
    }
    const streams = probe(bundle, output).streams
    assert(streams.some(stream => stream.codec_name === 'h264'))
    assert(streams.some(stream => stream.codec_name === 'aac' && stream.channels === 2))
    ff(bundle, ['-i', output, '-vf', 'fps=5,scale=-2:64,setsar=1,tile=3x1', '-frames:v', '1', join(cwd, `${encoder}.jpg`)])
    ff(bundle, ['-i', output, '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', join(cwd, `${encoder}.wav`)])
  }
  console.log(`PASS ${label}: OpenH264, optional Media Foundation, AAC, JPEG filmstrip and PCM waveform`)
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
  ff(bundle, ['-i', join(cwd, 'audio.flac'), '-c:a', 'aac', join(cwd, 'audio.m4a')])
  ff(bundle, ['-i', join(cwd, 'frame.png'), '-vf', 'crop=128:128:0:0,format=rgba,split[fg][bg];[bg]geq=r=190:g=190:b=190:a=255[checker];[checker][fg]overlay', '-frames:v', '1', join(cwd, 'poster.jpg')])
  console.log(`PASS ${label}: VP9 alpha/overlay pixels, ProRes 4444, PNG/image pipe, MPEG-4/frame hashes, H.264 stream copy, posters, MP3/Opus/FLAC and native AAC`)
}

export async function verifyBundle(directory, { smoke = false } = {}) {
  if (process.platform !== 'win32') throw new Error('Verification requires Windows')
  const bundle = resolve(directory)
  const temporary = await mkdtemp(join(tmpdir(), 'vis-ffmpeg-windows-'))
  const errors = []
  const check = async (name, action) => {
    try { await action() } catch (error) {
      if (!smoke) throw error
      errors.push(`${name}: ${error.message}`)
      console.error(`FAIL ${name}: ${error.message}`)
    }
  }
  try {
    // Smoke keeps failures visible while exercising third-party binaries without invented BUILDINFO.
    if (smoke) console.log('SMOKE ONLY: source verification skipped; failures still produce a nonzero exit')
    else await inspectSources(bundle)
    const pinned = JSON.parse(await readFile(new URL('./sources.json', import.meta.url), 'utf8')).find(source => source.id === 'ffmpeg').version
    for (const [location, label] of [[bundle, 'original'], [join(temporary, 'different location with spaces', 'ffmpeg'), 'relocated']]) {
      if (label === 'relocated') await cp(bundle, location, { recursive: true, filter: path => basename(path) !== 'source' })
      await check(`${label} configuration`, () => inspectConfiguration(location, pinned))
      await check(`${label} imports`, () => inspectImports(location))
      await check(`${label} requirements`, () => inspectRequirements(location))
      await check(`${label} functional`, () => functional(location, label, temporary))
    }
    if (errors.length) throw new Error(`Smoke failed ${errors.length} check groups:\n${errors.join('\n')}`)
    console.log('PASS original and relocated Windows bundle')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  const smoke = args.includes('--smoke')
  const positional = args.filter(arg => arg !== '--smoke')
  if (positional.length !== 1 || positional[0].startsWith('--')) throw new Error('Usage: node scripts/ffmpeg/verify-windows.mjs <win32-x64-directory> [--smoke]')
  await verifyBundle(positional[0], { smoke })
}
