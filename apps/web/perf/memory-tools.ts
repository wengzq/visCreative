import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CDPSession } from 'playwright-core'

const bytes = (value: string, unit: string) => Number(value) * ({ B: 1, KB: 1024, MB: 2 ** 20, GB: 2 ** 30 }[unit] ?? NaN)
export const mib = (value: number) => (value / 2 ** 20).toFixed(1)

/** CDP reports OS PIDs for this browser only, avoiding other workers' Chrome processes. */
export async function physicalMemory(browserCdp: CDPSession, directory: string, label: string) {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo')
  const processes = processInfo.filter(p => ['renderer', 'GPU'].includes(p.type)).map(p => {
    const output = execFileSync('footprint', ['-p', String(p.id)], { encoding: 'utf8', timeout: 15_000 })
    writeFileSync(join(directory, `${label}-${p.type}-${p.id}.footprint.txt`), output)
    const match = output.match(/Footprint:\s+([\d.]+) (B|KB|MB|GB)/)
    if (!match) throw new Error(`Missing physical footprint for PID ${p.id}`)
    return { pid: p.id, type: p.type, bytes: bytes(match[1]!, match[2]!) }
  })
  if (!processes.some(p => p.type === 'renderer') || !processes.some(p => p.type === 'GPU')) throw new Error('Missing renderer or GPU process')
  writeFileSync(join(directory, `${label}-processes.json`), JSON.stringify(processInfo, null, 2))
  return {
    renderer: processes.filter(p => p.type === 'renderer').reduce((sum, p) => sum + p.bytes, 0),
    gpu: processes.filter(p => p.type === 'GPU').reduce((sum, p) => sum + p.bytes, 0),
    processes,
  }
}

export async function heapSnapshot(cdp: CDPSession, directory: string, label: string) {
  const chunks: string[] = []
  const receive = ({ chunk }: { chunk: string }) => chunks.push(chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', receive)
  try { await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }) }
  finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', receive) }
  const source = chunks.join('')
  writeFileSync(join(directory, `${label}.heapsnapshot`), source)
  const heap = JSON.parse(source) as {
    snapshot: { meta: { node_fields: string[]; node_types: (string[] | string)[] } }
    nodes: number[]
    strings: string[]
  }
  const fields = heap.snapshot.meta.node_fields
  const types = heap.snapshot.meta.node_types[fields.indexOf('type')] as string[]
  const summary: Record<string, { count: number; detached: number; selfBytes: number }> = {}
  for (let offset = 0; offset < heap.nodes.length; offset += fields.length) {
    const name = heap.strings[heap.nodes[offset + fields.indexOf('name')]!]!
    const type = types[heap.nodes[offset + fields.indexOf('type')]!]
    const tag = type === 'native' ? name.match(/^<(video|audio|img)(?:\s|>)/)?.[1] : undefined
    if (!tag && (!['native', 'object'].includes(type!) || !/HTML(Video|Audio|Media|Image)Element|AudioContext|MediaElementAudioSourceNode|GainNode|^blink::ImageResource(?:Content)?$/.test(name))) continue
    const key = tag ? `native DOM: <${tag}>` : `${type}: ${name}`
    const entry = summary[key] ??= { count: 0, detached: 0, selfBytes: 0 }
    entry.count++
    if (fields.includes('detachedness') && heap.nodes[offset + fields.indexOf('detachedness')] === 2) entry.detached++
    entry.selfBytes += heap.nodes[offset + fields.indexOf('self_size')]!
  }
  writeFileSync(join(directory, `${label}-heap-summary.json`), JSON.stringify(summary, null, 2))
  return summary
}
