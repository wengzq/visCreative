import { randomFillSync } from 'node:crypto'

// ULIDs with type prefixes (see 0002 "Conventions"): time-ordered, never-reused identifiers
export const ID_PREFIXES = {
  session: 'ses',
  agentInstance: 'ain',
  message: 'msg',
  turn: 'trn',
  transcriptItem: 'itm',
  node: 'node',
  slot: 'slot',
  asset: 'ast',
  assetVersion: 'astv',
  snapshot: 'snap',
  job: 'job',
  attempt: 'att',
  binding: 'bind',
  operation: 'op',
  space: 'spc',
  workItem: 'work',
  workMessage: 'wmsg',
} as const
export type IdKind = keyof typeof ID_PREFIXES

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(now: number = Date.now()): string {
  let time = ''
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) {
    time = CROCKFORD[t % 32] + time
  }
  const bytes = randomFillSync(new Uint8Array(16))
  let rand = ''
  for (const b of bytes) rand += CROCKFORD[b % 32]
  return time + rand
}

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`
}
