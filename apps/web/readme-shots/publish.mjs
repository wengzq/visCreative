import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const input = resolve(process.argv[2] ?? process.env.VIS_SHOTS_OUT ?? join(tmpdir(), 'vis-readme-shots'))
const ffmpeg = process.env.VIS_SHOTS_FFMPEG ?? 'ffmpeg'
const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8'))
for (const locale of ['en', 'zh-CN']) {
  const readme = readFileSync(join(root, locale === 'en' ? 'README.md' : 'README.zh-CN.md'), 'utf8')
  const names = [...new Set([...readme.matchAll(new RegExp(`docs/images/${locale}/([a-z-]+)\\.webp`, 'g'))].map(match => match[1]))]
  for (const name of names) {
    const source = join(input, locale, `${name}.png`)
    if (!manifest.locales[locale].includes(name) || !existsSync(source)) throw new Error(`Missing capture: ${locale}/${name}`)
  }
  mkdirSync(join(root, 'docs/images', locale), { recursive: true })
  for (const name of names) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', join(input, locale, `${name}.png`), '-c:v', 'libwebp', '-quality', '90', '-compression_level', '6', join(root, 'docs/images', locale, `${name}.webp`)], { windowsHide: true })
    console.log(`[shots] published ${locale}/${name}.webp`)
  }
}
