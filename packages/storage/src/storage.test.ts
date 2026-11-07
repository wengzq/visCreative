import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent, currentSeq, readEventsAfter } from './events'
import { openAppDb, openSpaceDb, type SpaceDb } from './open'
import * as s from './schema/space'
import * as app from './schema/app'
import { EMPTY_SCRIPT } from '@vis/protocol'

const now = 1_800_000_000_000

function seed(db: SpaceDb) {
  db.insert(s.sessions).values({ id: 'ses_1', agentKind: 'claude', title: 't', createdAt: now }).run()
  db.insert(s.operations).values({ id: 'op_1', actorKind: 'user', createdAt: now }).run()
  db.insert(s.nodes).values({ id: 'node_1', kind: 'text', x: 0, y: 0, w: 1, h: 1, z: 0, createdAt: now }).run()
  db.insert(s.slots).values({ id: 'slot_1', nodeId: 'node_1', slotKey: 'main', contentType: 'text' }).run()
}

describe('openSpaceDb', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-storage-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sets WAL, synchronous=FULL and foreign keys, and allows repeated opening', () => {
    const file = join(dir, 'space.db')
    const db = openSpaceDb(file)
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.$client.pragma('synchronous', { simple: true })).toBe(2)
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1)
    seed(db)
    const generation = { provider: 'ark', model: 'image-model', params: { ratio: '16:9', nested: { quality: 2 } } }
    db.insert(s.nodes).values({ id: 'node_input', kind: 'image', x: 0, y: 0, w: 1, h: 1, z: 1, generation, createdAt: now }).run()
    db.insert(s.nodeInputs).values({ nodeId: 'node_1', ordinal: 0, inputNodeId: 'node_input' }).run()
    db.$client.close()

    const reopened = openSpaceDb(file)
    expect(reopened.select().from(s.nodes).all()).toMatchObject([{ id: 'node_1', generation: null }, { id: 'node_input', generation }])
    expect(reopened.select().from(s.sessions).get()).toMatchObject({ title: 't', titleSource: 'default' })
    expect(reopened.select().from(s.nodeInputs).all()).toEqual([{ nodeId: 'node_1', ordinal: 0, inputNodeId: 'node_input' }])
    reopened.$client.close()
  })

  it('opens app.db', () => {
    const db = openAppDb(join(dir, 'app.db'))
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1)
    db.$client.close()
  })

  it('upgrades a timeline-editor-era database with nullable video frame rates', () => {
    const migrations = join(dir, 'timeline-era-migrations')
    mkdirSync(join(migrations, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(new URL('../migrations/space/meta/_journal.json', import.meta.url), 'utf8'))
    const entries = journal.entries.slice(0, 22) as { tag: string }[]
    for (const entry of entries) copyFileSync(new URL(`../migrations/space/${entry.tag}.sql`, import.meta.url), join(migrations, `${entry.tag}.sql`))
    writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    const file = join(dir, 'timeline-era.db')
    const old = drizzle(new Database(file))
    migrate(old, { migrationsFolder: migrations })
    old.$client.prepare('INSERT INTO blobs (hash, byte_size, created_at) VALUES (?, ?, ?)').run('old-blob', 1, now)
    old.$client.prepare('INSERT INTO assets (id, kind, origin, created_at) VALUES (?, ?, ?, ?)').run('old-asset', 'video', 'import', now)
    old.$client.prepare('INSERT INTO asset_versions (id, asset_id, version, blob_hash, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('old-version', 'old-asset', 1, 'old-blob', 'video/mp4', now)
    old.$client.close()
    const upgraded = openSpaceDb(file)
    expect(upgraded.select().from(s.assetVersions).get()).toMatchObject({ id: 'old-version', fps: null })
    upgraded.insert(s.assetVersions).values({ id: 'new-version', assetId: 'old-asset', version: 2, blobHash: 'old-blob', mime: 'video/mp4', fps: 29.97, createdAt: now }).run()
    expect(upgraded.$client.pragma('foreign_key_check')).toEqual([])
    upgraded.$client.close()
    const reopened = openSpaceDb(file)
    expect(reopened.select().from(s.assetVersions).all().map(row => row.fps)).toEqual([null, 29.97])
    reopened.$client.close()
  })

  it('persists script documents and non-owning shot links across reopening', () => {
    const file = join(dir, 'scripts.db')
    const db = openSpaceDb(file)
    seed(db)
    const shot = { scriptNodeId: 'missing-script', shotId: 'shot_1', role: 'video' as const }
    db.insert(s.nodes).values({ id: 'script', kind: 'script', x: 0, y: 0, w: 480, h: 320, z: 1, shot, createdAt: now }).run()
    db.insert(s.slots).values({ id: 'script-main', nodeId: 'script', slotKey: 'main', contentType: 'script', currentRevision: 1 }).run()
    db.insert(s.slotRevisions).values({ slotId: 'script-main', revision: 1, scriptDoc: EMPTY_SCRIPT, operationId: 'op_1', createdAt: now }).run()
    db.$client.close()
    const reopened = openSpaceDb(file)
    expect(reopened.select().from(s.nodes).all().find(node => node.id === 'script')?.shot).toEqual(shot)
    expect(reopened.select().from(s.slotRevisions).get()?.scriptDoc).toEqual(EMPTY_SCRIPT)
    expect(reopened.$client.pragma('foreign_key_check')).toEqual([])
    reopened.$client.close()
  })

  it('upgrades existing generation input pointers before rebuilding their nullable columns', () => {
    const migrations = join(dir, 'before-entities')
    mkdirSync(join(migrations, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(new URL('../migrations/space/meta/_journal.json', import.meta.url), 'utf8'))
    const entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 23) as { tag: string }[]
    for (const entry of entries) copyFileSync(new URL(`../migrations/space/${entry.tag}.sql`, import.meta.url), join(migrations, `${entry.tag}.sql`))
    writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    const file = join(dir, 'existing-job.db')
    const old = drizzle(new Database(file))
    migrate(old, { migrationsFolder: migrations })
    old.$client.exec(`
      INSERT INTO operations (id, actor_kind, created_at) VALUES ('op', 'user', 1);
      INSERT INTO nodes (id, kind, x, y, w, h, z, created_at) VALUES ('node', 'text', 0, 0, 1, 1, 0, 1);
      INSERT INTO slots (id, node_id, slot_key, content_type, current_revision) VALUES ('slot', 'node', 'main', 'text', 1);
      INSERT INTO slot_revisions (slot_id, revision, text_body, operation_id, created_at) VALUES ('slot', 1, 'Original', 'op', 1);
      INSERT INTO generation_jobs (id, kind, provider, model, params, status, created_at, updated_at) VALUES ('job', 'image', 'mock', 'mock-image-1', '{}', 'queued', 1, 1);
      INSERT INTO job_inputs (job_id, ordinal, slot_id, slot_revision, from_snapshot) VALUES ('job', 0, 'slot', 1, 0);
    `)
    old.$client.close()
    const upgraded = openSpaceDb(file)
    expect(upgraded.select().from(s.jobInputs).all()).toEqual([{ jobId: 'job', ordinal: 0, slotId: 'slot', slotRevision: 1, assetVersionId: null, fromSnapshot: false }])
    expect(upgraded.$client.pragma('foreign_key_check')).toEqual([])
    expect(() => upgraded.insert(s.jobInputs).values({ jobId: 'job', ordinal: 1, fromSnapshot: false }).run()).toThrow(/CHECK/)
    upgraded.$client.close()
  })

  it('executor slots are unique across projects and must belong to an existing project', () => {
    const db = openAppDb(join(dir, 'app.db'))
    db.insert(app.spaces).values([
      { id: 'spc_1', name: 'one', dir: '/one', createdAt: now },
      { id: 'spc_2', name: 'two', dir: '/two', createdAt: now },
    ]).run()
    db.insert(app.workSlots).values({ workItemId: 'work_1', spaceId: 'spc_1', acquiredAt: now }).run()
    expect(() => db.insert(app.workSlots).values({ workItemId: 'work_1', spaceId: 'spc_2', acquiredAt: now }).run()).toThrow(/UNIQUE/)
    expect(() => db.insert(app.workSlots).values({ workItemId: 'work_2', spaceId: 'missing', acquiredAt: now }).run()).toThrow(/FOREIGN KEY/)
    db.$client.close()
  })

  it('upgrade gives each legacy session an independent work item, preserving directory, history and archive state', () => {
    const migrations = join(dir, 'old-work-migrations')
    mkdirSync(join(migrations, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(new URL('../migrations/space/meta/_journal.json', import.meta.url), 'utf8'))
    const entries = journal.entries.slice(0, 7) as { tag: string }[]
    for (const entry of entries) copyFileSync(new URL(`../migrations/space/${entry.tag}.sql`, import.meta.url), join(migrations, `${entry.tag}.sql`))
    writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    const file = join(dir, 'before-work.db')
    const old = drizzle(new Database(file))
    migrate(old, { migrationsFolder: migrations })
    old.$client.prepare('INSERT INTO sessions (id, agent_kind, title, work_dir, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ses_active', 'codex', '进行中', '/projects/active', now, null)
    old.$client.prepare('INSERT INTO sessions (id, agent_kind, title, work_dir, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ses_archived', 'claude', '已归档', '/projects/archived', now - 2, now - 1)
    old.$client.prepare('INSERT INTO messages (id, session_id, text, delivery_state, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('msg_old', 'ses_active', '原消息', 'submitted', now)
    old.$client.close()

    const upgraded = openSpaceDb(file)
    expect(upgraded.select().from(s.workItems).all()).toMatchObject([
      { id: 'work_active', title: '进行中', status: 'in_progress', workDir: '/projects/active', createdBy: { kind: 'user' }, revision: 1, statusChangedAt: now, createdAt: now, archivedAt: null },
      { id: 'work_archived', title: '已归档', status: 'done', workDir: '/projects/archived', statusChangedAt: now - 1, createdAt: now - 2, archivedAt: now - 1 },
    ])
    expect(upgraded.select().from(s.sessions).all()).toMatchObject([
      { id: 'ses_active', workItemId: 'work_active', workDir: '/projects/active' },
      { id: 'ses_archived', workItemId: 'work_archived', workDir: '/projects/archived' },
    ])
    expect(upgraded.select().from(s.messages).get()).toMatchObject({ id: 'msg_old', sessionId: 'ses_active', text: '原消息' })
    expect(upgraded.select().from(s.nodes).all()).toEqual([])
    expect(upgraded.$client.pragma('foreign_key_check')).toEqual([])
    upgraded.$client.close()
    const reopened = openSpaceDb(file)
    expect(reopened.select().from(s.workItems).all()).toHaveLength(2)
    reopened.$client.close()
  })

  it('upgrading existing spaces preserves nodes and titles, defaulting title source to default', () => {
    const migrations = join(dir, 'old-migrations')
    mkdirSync(join(migrations, 'meta'), { recursive: true })
    copyFileSync(new URL('../migrations/space/0000_init.sql', import.meta.url), join(migrations, '0000_init.sql'))
    const journal = JSON.parse(readFileSync(new URL('../migrations/space/meta/_journal.json', import.meta.url), 'utf8'))
    writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }))
    const file = join(dir, 'old-space.db')
    const old = drizzle(new Database(file), { schema: s })
    migrate(old, { migrationsFolder: migrations })
    old.$client.exec(`INSERT INTO sessions (id, agent_kind, title, created_at) VALUES ('ses_1', 'claude', '已有标题', ${now})`)
    old.$client.prepare("INSERT INTO nodes (id, kind, x, y, w, h, z, created_at) VALUES ('node_1', 'text', 0, 0, 1, 1, 0, ?)").run(now)
    old.$client.close()

    const upgraded = openSpaceDb(file)
    expect(upgraded.select().from(s.nodes).all()).toMatchObject([{ id: 'node_1', generation: null }])
    expect(upgraded.select().from(s.sessions).get()).toMatchObject({ title: '已有标题', titleSource: 'default' })
    expect(upgraded.select().from(s.nodeInputs).all()).toEqual([])
    upgraded.insert(s.nodeInputs).values({ nodeId: 'node_1', ordinal: 0, inputNodeId: 'node_1' }).run()
    upgraded.$client.close()
    const reopened = openSpaceDb(file)
    expect(reopened.select().from(s.nodeInputs).all()).toEqual([{ nodeId: 'node_1', ordinal: 0, inputNodeId: 'node_1' }])
    expect(reopened.select().from(s.sessions).get()).toMatchObject({ title: '已有标题', titleSource: 'default' })
    reopened.$client.close()
  })
})

describe('space.db constraints', () => {
  let db: SpaceDb
  beforeEach(() => { db = openSpaceDb(':memory:'); seed(db) })

  it('a work item can retain multiple unarchived sessions without role-based uniqueness', () => {
    db.insert(s.workItems).values({ id: 'work_1', title: '工作项', workDir: '/work', createdBy: { kind: 'user' }, statusChangedAt: now, createdAt: now }).run()
    for (const id of ['ses_a', 'ses_b', 'ses_c']) {
      db.insert(s.sessions).values({ id, workItemId: 'work_1', agentKind: 'codex', title: id, createdAt: now }).run()
    }
    expect(db.select().from(s.sessions).all().filter(session => session.workItemId === 'work_1')).toHaveLength(3)
  })

  it('deleting a frame only clears canvas membership, preserving contained nodes and independent work items', () => {
    db.insert(s.nodes).values({ id: 'node_frame', kind: 'frame', frame: { title: '框', color: 'gray' }, x: 0, y: 0, w: 320, h: 200, z: -1, createdAt: now }).run()
    db.insert(s.workItems).values({ id: 'work_1', title: '工作项', workDir: '/work', createdBy: { kind: 'user' }, statusChangedAt: now, createdAt: now }).run()
    db.$client.prepare('UPDATE nodes SET frame_id = ? WHERE id = ?').run('node_frame', 'node_1')
    db.$client.prepare('DELETE FROM nodes WHERE id = ?').run('node_frame')
    expect(db.select().from(s.nodes).get()).toMatchObject({ id: 'node_1', frameId: null })
    expect(db.select().from(s.workItems).get()).toMatchObject({ id: 'work_1', revision: 1 })
  })

  it('at most one active runtime instance per session at a time', () => {
    const instance = (id: string, status: 'starting' | 'ready' | 'exited') =>
      db.insert(s.agentInstances).values({ id, sessionId: 'ses_1', status, tokenHash: id, startedAt: now }).run()
    instance('ain_1', 'exited')
    instance('ain_2', 'ready')
    expect(() => instance('ain_3', 'starting')).toThrow(/UNIQUE/)
    instance('ain_4', 'exited')
  })

  it('slot revisions cannot contain both an asset and a body', () => {
    db.insert(s.blobs).values({ hash: 'h', byteSize: 1, createdAt: now }).run()
    db.insert(s.assets).values({ id: 'ast_1', kind: 'image', origin: 'import', createdAt: now }).run()
    db.insert(s.assetVersions).values({ id: 'astv_1', assetId: 'ast_1', version: 1, blobHash: 'h', mime: 'image/png', createdAt: now }).run()
    expect(() =>
      db.insert(s.slotRevisions).values({ slotId: 'slot_1', revision: 1, assetVersionId: 'astv_1', textBody: 'x', operationId: 'op_1', createdAt: now }).run(),
    ).toThrow(/CHECK/)
  })

  it('reference inputs are unique by node and index, and both ends must be existing nodes', () => {
    db.insert(s.nodes).values({ id: 'node_input', kind: 'image', x: 0, y: 0, w: 1, h: 1, z: 1, createdAt: now }).run()
    const input = { nodeId: 'node_1', ordinal: 0, inputNodeId: 'node_input' }
    db.insert(s.nodeInputs).values(input).run()
    expect(() => db.insert(s.nodeInputs).values(input).run()).toThrow(/UNIQUE/)
    expect(() => db.insert(s.nodeInputs).values({ ...input, ordinal: 1, inputNodeId: 'missing' }).run()).toThrow(/FOREIGN KEY/)
    expect(() => db.insert(s.nodeInputs).values({ ...input, nodeId: 'missing' }).run()).toThrow(/FOREIGN KEY/)
    db.insert(s.nodeInputs).values({ ...input, ordinal: 1 }).run()
    expect(db.select().from(s.nodeInputs).all()).toHaveLength(2)
  })

  it('snapshots can only point to existing slot revisions', () => {
    db.insert(s.messages).values({ id: 'msg_1', sessionId: 'ses_1', text: 'hi', deliveryState: 'submitted', createdAt: now }).run()
    db.insert(s.turns).values({ id: 'trn_1', sessionId: 'ses_1', messageId: 'msg_1', status: 'running' }).run()
    db.insert(s.inputSnapshots).values({ id: 'snap_1', turnId: 'trn_1', createdAt: now }).run()
    db.insert(s.slotRevisions).values({ slotId: 'slot_1', revision: 1, textBody: 'v1', operationId: 'op_1', createdAt: now }).run()

    db.insert(s.snapshotItems).values({ snapshotId: 'snap_1', ordinal: 0, nodeId: 'node_1', slotId: 'slot_1', slotRevision: 1 }).run()
    expect(() =>
      db.insert(s.snapshotItems).values({ snapshotId: 'snap_1', ordinal: 1, nodeId: 'node_1', slotId: 'slot_1', slotRevision: 2 }).run(),
    ).toThrow(/FOREIGN KEY/)
  })

  it('slot target bindings require node, slot and expected revision; each output can be bound only once', () => {
    db.insert(s.generationJobs).values({ id: 'job_1', kind: 'image', provider: 'mock', model: 'm', params: {}, status: 'queued', createdAt: now, updatedAt: now }).run()
    expect(() =>
      db.insert(s.deliveryBindings).values({ id: 'bind_0', jobId: 'job_1', outputIndex: 0, targetKind: 'slot', status: 'pending' }).run(),
    ).toThrow(/CHECK/)
    const binding = { jobId: 'job_1', outputIndex: 0, targetKind: 'slot', nodeId: 'node_1', slotId: 'slot_1', expectedContentRevision: 0, status: 'pending' } as const
    db.insert(s.deliveryBindings).values({ id: 'bind_1', ...binding }).run()
    expect(() => db.insert(s.deliveryBindings).values({ id: 'bind_2', ...binding }).run()).toThrow(/UNIQUE/)
  })
})

describe('Events', () => {
  it('sequences increase, support cursor replay and roll back with transactions', () => {
    const db = openSpaceDb(':memory:')
    expect(currentSeq(db)).toBe(0)
    const a = appendEvent(db, { type: 'node.created', entityType: 'node', entityId: 'node_1', payload: { x: 1 } })
    const b = appendEvent(db, { type: 'node.updated', entityType: 'node', entityId: 'node_1', payload: { x: 2 } })
    expect(b).toBe(a + 1)

    expect(() =>
      db.transaction(tx => {
        appendEvent(tx, { type: 'node.deleted', entityType: 'node', entityId: 'node_1', payload: {} })
        throw new Error('Business write failed')
      }),
    ).toThrow('Business write failed')
    expect(currentSeq(db)).toBe(b)

    const after = readEventsAfter(db, a)
    expect(after.map(e => [e.seq, e.type, e.payload])).toEqual([[b, 'node.updated', { x: 2 }]])
  })
})
