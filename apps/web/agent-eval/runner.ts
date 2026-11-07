import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MethodResult, SpaceEvent, TranscriptItem, WorkMessageView } from '@vis/protocol'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { resolveDsh } from '../../../packages/workbench/deepseek/src/resolve-dsh'
import { resolveExecutable } from '../../../packages/workbench/core/src/resolve-executable'
import { killTree } from '../../../packages/workbench/core/src/kill-tree'
import { assertFreeProviders, assertMockConfiguration, parseOptions, prepareDirectories, type Options } from './safety'
import { buildFixture, finishedChildren, pause, requestId, snapshotEpisode, type Call, type Fixture } from './fixtures'
import { extract, runChecks, type Check, type Evidence } from './checks'
import scenarios from './scenarios.json'

type Scenario = typeof scenarios[number]
type Result = {
  agent: string; scenario: string; result: string; execution: string; durationMs: number
  toolCalls: number; toolErrors: number; checks: Check[]; error?: string
}
const json = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const terminalJob = (status: string) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(status)
const terminalBatch = (status: string) => ['succeeded', 'failed', 'cancelled', 'rejected', 'expired', 'paused'].includes(status)

async function bounded<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  let onAbort: () => void
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC exceeded ${ms}ms`)), ms)
    onAbort = () => reject(new Error('Evaluation interrupted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  try { return await Promise.race([promise, limit]) }
  finally {
    clearTimeout(timer!)
    signal?.removeEventListener('abort', onAbort!)
  }
}

async function transcript(call: Call, sessionId: string): Promise<TranscriptItem[]> {
  const items: TranscriptItem[] = []
  let beforeSeq: number | undefined
  for (;;) {
    const page = await call('session.getTranscript', { sessionId, limit: 500, ...(beforeSeq === undefined ? {} : { beforeSeq }) })
    items.push(...page.items)
    if (!page.hasMore) break
    const next = Math.min(...page.items.map(item => item.createdSeq))
    if (!Number.isFinite(next) || (beforeSeq !== undefined && next >= beforeSeq)) throw new Error('Transcript pagination did not advance')
    beforeSeq = next
  }
  return items.sort((a, b) => a.createdSeq - b.createdSeq)
}

function versions(options: Options) {
  if (options.dryRun) return { codex: { version: 'fake-codex/0', source: 'apps/web/e2e/fake-codex.mjs' }, deepseek: { version: 'not probed in dry run' } }
  const result: Record<string, unknown> = {}
  if (options.agents.includes('codex')) {
    const executable = resolveExecutable('codex', process.env.VIS_CODEX_PATH)
    result.codex = { executable, version: execFileSync(executable.command, [...executable.args, '--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  }
  if (options.agents.includes('deepseek')) {
    const dsh = resolveDsh()
    if (!dsh) throw new Error('DeepSeek Harness is not installed or VIS_DSH_PATH is invalid')
    result.deepseek = dsh
  }
  return result
}

function writeSummary(options: Options, results: Result[], metadata: unknown, failure?: string) {
  json(join(options.out, 'results.json'), { metadata, results, ...(failure ? { error: failure } : {}) })
  const rows = results.map(result => `| ${result.agent} | ${result.scenario} | ${result.result} | ${result.execution} | ${result.toolCalls} | ${result.toolErrors} | ${(result.durationMs / 1000).toFixed(2)} |`)
  writeFileSync(join(options.out, 'report.md'), [
    '# RFC 0026 agent evaluation', '',
    options.dryRun ? 'Dry run with fake Codex. Semantic failures are expected; this run verifies plumbing only.' : 'Real-agent run. Free built-in Mock and local render providers only.', '',
    '| Agent | Scenario | Result | Execution | Tool calls | Tool errors | Seconds |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |', ...rows, '',
    ...results.flatMap(result => [`## ${result.agent} / ${result.scenario}`, '', ...result.checks.map(check => `- **${check.result}** ${check.id}: ${check.detail}`), ...(result.error ? [`- Execution error: ${result.error}`] : []), '']),
    '## Interpretation', '',
    '- Baseline guide reads are informational; RFC 0029 previz scenarios explicitly check the required previz guide read.',
    '- Review means human judgment or missing adapter observability, never an automatic pass.',
    '- Q1 remains review: Mock/render do not count toward daily paid-agent quotas (packages/generation/src/quota.ts). Limits of 1 are configured; 0 means unlimited. No paid provider or artificial quota error is used.',
    '- Transcripts are fully paginated, but the product truncates individual tool results and does not expose token usage. Native tool activity may be absent from current adapters.',
    '- Scenario timings include fixture setup, turns, approvals, pending jobs and recording. See timing.json for boundaries.',
    ...(failure ? ['', `Runner error: ${failure}`] : []), '',
  ].join('\n'), { mode: 0o600 })
}

async function scenarioRun(options: Options, agent: Options['agents'][number], scenario: Scenario, call: Call, events: SpaceEvent[], checkAbort: () => void, root: string): Promise<Result> {
  const path = join(options.out, agent, scenario.id)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const start = Date.now()
  const deadline = start + options.timeoutMs
  let fixture: Fixture = { vars: {}, nodeIds: [], jobIds: [] }
  let session: MethodResult<'session.create'> | undefined
  let workItemId: string | undefined
  let parentSessionId: string | undefined
  let parentTranscript: Evidence['parentTranscript']
  let workInbox: Evidence['workInbox']
  let workItems: Evidence['workItems']
  let skills: Evidence['skills']
  let promptSentAt: number | undefined
  let endedAt: number | undefined
  let ended = false
  let execution = 'completed'
  let error: string | undefined
  const approvals: any[] = []
  const handled = new Set<string>()
  let items: TranscriptItem[] = []
  let before: Evidence['before'] = []
  let after: Evidence['after'] = []
  let batches: Evidence['batches'] = []
  let jobs: Evidence['jobs'] = []
  let assets: NonNullable<Evidence['assets']> = []
  let workMessages: WorkMessageView[] = []
  let proposals: NonNullable<Evidence['proposals']> = []
  const entities: NonNullable<Evidence['entities']> = { before: [], after: [] }
  const turnSnapshots: NonNullable<Evidence['turnSnapshots']> = []
  let earlierEpisode: Evidence['earlierEpisode']
  let workDir = ''
  let prompts: string[] = []
  const timeCheck = () => {
    checkAbort()
    if (Date.now() >= deadline) throw new Error('Scenario timeout')
  }
  const jobIds = () => [...new Set(events.filter(event => event.type === 'job.stateChanged').map(event => (event.payload as any).jobId as string))].filter(id => !fixture.jobIds.includes(id))
  const readJobs = async () => Promise.all(jobIds().map(jobId => call('generation.get', { jobId })))
  const handleApprovals = async () => {
    if (!session) return
    items = await transcript(call, session.sessionId)
    for (const item of items.filter(item => item.kind === 'approval')) {
      const approval = item.payload as any
      if (approval.status !== 'pending' || handled.has(approval.approvalId)) continue
      handled.add(approval.approvalId)
      const record = { ...approval, observedAt: Date.now(), pendingObserved: true }
      approvals.push(record)
      if (approval.kind === 'text_delete' || approval.kind === 'work_delete') {
        // A pending deletion is the evidence under test. The harness must never impersonate its user click.
        Object.assign(record, { harnessAction: 'left_pending' })
      } else if (approval.kind === 'generation_batch' && approval.batchId) {
        // Deliberately observe a pending interval before approving, so the test can detect bypass submits.
        await pause(1000)
        timeCheck()
        const batch = await call('script.batch.get', { batchId: approval.batchId })
        const current = extract(await transcript(call, session.sessionId))
        Object.assign(record, { statusAtApproval: batch.status, jobsBeforeApproval: jobIds().length, noSingleSubmits: !current.calls.some(tool => tool.name === 'gen_submit'), approvedAt: Date.now() })
        await call('script.batch.approve', { requestId: requestId(), batchId: approval.batchId })
      } else {
        Object.assign(record, { decision: 'deny', deniedAt: Date.now() })
        await call('session.respondApproval', { requestId: requestId(), approvalId: approval.approvalId, decision: 'deny' })
      }
    }
  }
  try {
    const project = await call('space.create', { requestId: requestId(), name: `Eval ${agent} ${scenario.id}`, rootPath: join(options.projectsDir, `${agent}-${scenario.id}`) })
    await call('events.subscribe', { spaceId: project.spaceId })
    events.length = 0
    fixture = await buildFixture(scenario.fixture, call, project.rootPath, timeCheck, root, project.spaceId)
    before = (await call('canvas.get', {})).nodes
    entities.before = (await call('entity.list', { includeDeleted: true })).items
    prompts = scenario.prompts.map(prompt => prompt.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      if (!(key in fixture.vars)) throw new Error(`Unknown fixture variable: ${key}`)
      return fixture.vars[key]!
    }) + (options.dryRun && scenario.dryRunSuffix ? `\n${scenario.dryRunSuffix}` : ''))
    json(join(path, 'prompts.json'), prompts)
    json(join(path, 'fixture.json'), fixture)
    if (scenario.fixture === 'work' || scenario.fixture === 'child-review') {
      let parentId: string
      if (scenario.fixture === 'child-review') {
        const parent = await call('session.create', { requestId: requestId(), agentKind: agent, title: 'Evaluation parent', workDir: project.rootPath })
        parentSessionId = parent.sessionId
        parentId = parent.workItemId!
        // Retain parent-directed reports in the inbox without starting another real Agent turn.
        await call('work.move', { requestId: requestId(), workItemId: parentId, status: 'todo' })
      } else parentId = (await call('work.create', { requestId: requestId(), title: 'Evaluation parent' })).item.workItemId
      const child = await call('work.dispatch', { requestId: requestId(), parentId, title: 'Evaluation child', brief: prompts[0]!, agentKind: agent, activate: false, reviewBy: 'parent' })
      workItemId = child.item.workItemId
      session = (await call('session.list', {})).sessions.find(session => session.sessionId === child.item.sessions[0]!.sessionId)!
    } else {
      session = await call('session.create', { requestId: requestId(), agentKind: agent, title: `${scenario.id} evaluation`, workDir: project.rootPath })
    }
    if (!session) throw new Error('Scenario session was not created')
    if (scenario.fixture === 'finished-children') {
      fixture.vars.parentWorkItemId = session.workItemId!
      fixture.workItems = await finishedChildren(call, session.workItemId!, agent)
      fixture.vars.childWorkItemIds = fixture.workItems.map(item => item.workItemId).join(',')
      fixture.vars.childWorkItemIdsJson = JSON.stringify(fixture.workItems.map(item => item.workItemId))
      if (options.dryRun) prompts[0] = prompts[0]!.replace('{{childWorkItemIdsJson}}', fixture.vars.childWorkItemIdsJson)
      workItems = { before: (await call('work.list', {})).items, after: [] }
    }
    if (scenario.fixture === 'child-review') {
      fixture.vars.childSessionId = session.sessionId
      fixture.vars.childWorkItemId = workItemId!
      fixture.vars.parentSessionId = parentSessionId!
    }
    skills = { before: await call('skill.libraryList', {}), after: { skills: [], drafts: [] } }
    json(join(path, 'fixture.json'), fixture)
    json(join(path, 'prompts.json'), prompts)
    workDir = session.workDir
    session = await call('session.setApprovalMode', { requestId: requestId(), sessionId: session.sessionId, mode: 'auto' })
    json(join(path, 'session.json'), session)
    json(join(path, 'agent-options.json'), await call('session.agentOptions', { sessionId: session.sessionId }))
    events.length = 0
    promptSentAt = Date.now()
    for (const [index, prompt] of prompts.entries()) {
      timeCheck()
      const existingTurns = new Set((await transcript(call, session.sessionId)).map(item => item.turnId).filter(Boolean))
      if (workItemId && index === 0) await call('work.activate', { requestId: requestId(), workItemId, agentKind: agent })
      else await call('session.sendMessage', { requestId: requestId(), sessionId: session.sessionId, text: prompt, refs: fixture.nodeIds.map(nodeId => ({ nodeId, versionPolicy: 'latest-at-execution' })) })
      for (;;) {
        timeCheck()
        await handleApprovals()
        const current = (await call('session.list', {})).sessions.find(current => current.sessionId === session!.sessionId)
        const turnIds = [...new Set(items.map(item => item.turnId).filter((id): id is string => !!id && !existingTurns.has(id)))]
        const endedTurns = events.filter(event => event.type === 'turn.stateChanged' && turnIds.includes((event.payload as any).turnId) && ['completed', 'failed', 'interrupted'].includes((event.payload as any).status))
        if (!current?.activeTurnId && turnIds.length && endedTurns.length) {
          const failed = endedTurns.find(event => (event.payload as any).status !== 'completed')
          if (failed) {
            execution = (failed.payload as any).status
            error = 'Agent turn did not complete successfully'
          }
          turnSnapshots.push({ turnId: turnIds.at(-1)!, nodes: (await call('canvas.get', {})).nodes })
          break
        }
        await pause(200)
      }
      if (execution !== 'completed') break
    }
    ended = true
    endedAt = Date.now()
    // Generation and batch work can outlive the agent turn; observe terminal output before scoring.
    for (;;) {
      timeCheck()
      batches = (await call('script.batch.list', {})).batches
      jobs = await readJobs()
      if (batches.every(batch => terminalBatch(batch.status)) && jobs.every(job => terminalJob(job.status))) break
      await pause(200)
    }
  } catch (failure) {
    error = message(failure)
    execution = error === 'Scenario timeout' ? 'timeout' : 'error'
    // A stop request is recorded separately from its eventual completion, as required by session.stop.
    if (session) {
      try {
        const current = (await call('session.list', {})).sessions.find(current => current.sessionId === session!.sessionId)
        if (current?.activeTurnId) {
          await call('session.stop', { requestId: requestId(), sessionId: session.sessionId, turnId: current.activeTurnId })
          json(join(path, 'stop.json'), { requestedAt: Date.now(), turnId: current.activeTurnId })
        }
      } catch {}
    }
  } finally {
    // Best-effort snapshots survive failed turns and timeouts. Never convert missing evidence to a pass.
    try {
      after = (await call('canvas.get', {})).nodes
      batches = (await call('script.batch.list', {})).batches
      jobs = await readJobs()
      const assetIds = new Set([
        ...jobs.flatMap(job => job.outputs.map(output => output.assetVersionId)),
        ...after.flatMap(node => node.slots.flatMap(slot => slot.content.type === 'asset' ? [slot.content.assetVersionId] : slot.content.type === 'previz' ? slot.content.doc.panels.flatMap(panel => [panel.underlay, panel.sketch, panel.image, panel.blockout].filter((id): id is string => !!id)) : [])),
      ])
      assets = await Promise.all([...assetIds].map(assetVersionId => call('asset.get', { assetVersionId })))
      if (session) items = await transcript(call, session.sessionId)
      if (parentSessionId) {
        parentTranscript = await transcript(call, parentSessionId)
        workInbox = await call('work.inbox', {})
      }
      if (workItems) workItems.after = (await call('work.list', {})).items
      if (skills) skills.after = await call('skill.libraryList', {})
      proposals = (await call('text.proposal.list', { status: 'all' })).proposals
      entities.after = (await call('entity.list', { includeDeleted: true })).items
      if (fixture.earlierEpisode) {
        const inspector = await openStudiodLink({ socketPath: studiodEndpoint(options.dataDir), tokenPath: join(options.dataDir, 'run/studiod.token') })
        try {
          const inspect: Call = (method, params) => bounded(inspector.call(method, params), 10_000)
          earlierEpisode = { before: fixture.earlierEpisode, after: await snapshotEpisode(inspect, fixture.earlierEpisode.spaceId) }
        } finally { inspector.close() }
      }
      if (workItemId) {
        let beforeCreatedAt: number | undefined
        for (;;) {
          const detail = await call('work.get', { workItemId, limit: 200, ...(beforeCreatedAt === undefined ? {} : { beforeCreatedAt }) })
          workMessages.push(...detail.messages)
          if (!detail.hasMore) break
          const next = Math.min(...detail.messages.map(message => message.createdAt))
          if (!Number.isFinite(next) || next === beforeCreatedAt) throw new Error('Work message pagination did not advance')
          beforeCreatedAt = next
        }
      }
    } catch (failure) {
      error = [error, `Recording: ${message(failure)}`].filter(Boolean).join('; ')
      execution = 'error'
    }
    // session.create also creates an active root work item. Recall frees its global execution slot before the next project.
    if (session?.workItemId) {
      try {
        const cleanup = await call('work.recall', { requestId: requestId(), workItemId: session.workItemId })
        json(join(path, 'cleanup.json'), cleanup)
      } catch (failure) {
        error = [error, `Cleanup: ${message(failure)}`].filter(Boolean).join('; ')
        execution = 'error'
      }
    }
    // A read-only fallback measures a locked-down agent, not the product; stop rather than record misleading results.
    if (!options.dryRun && items.some(item => item.kind === 'notice' && (item.payload as { code?: string } | null)?.code === 'sandbox_read_only')) {
      json(join(path, 'transcript.json'), { items, hasMore: false })
      throw new Error(`${agent}/${scenario.id}: the agent ran in the read-only sandbox fallback; results would not reflect normal sessions`)
    }
    const evidence: Evidence = { before, after, transcript: items, events: [...events], jobs, assets, batches, approvals, fixtureVars: fixture.vars, workMessages, workDir, prompts, ended, proposals, entities, turnSnapshots, ...(workItems ? { workItems } : {}), ...(parentTranscript ? { parentTranscript } : {}), ...(workInbox ? { workInbox } : {}), ...(skills ? { skills } : {}), ...(earlierEpisode ? { earlierEpisode } : {}) }
    const checks = runChecks(scenario.checks, evidence)
    if (execution !== 'completed') checks.push({ id: 'execution', result: 'fail', detail: error ?? execution })
    const extracted = extract(items)
    json(join(path, 'transcript.json'), { items, hasMore: false })
    json(join(path, 'canvas.json'), { before: { nodes: before }, after: { nodes: after } })
    json(join(path, 'jobs.json'), jobs)
    json(join(path, 'assets.json'), assets)
    json(join(path, 'batches.json'), batches)
    json(join(path, 'approvals.json'), approvals)
    json(join(path, 'events.json'), evidence.events)
    json(join(path, 'work-messages.json'), workMessages)
    json(join(path, 'extracted.json'), extracted)
    json(join(path, 'proposal-attempts.json'), extracted.calls.filter(call => call.name === 'text_propose'))
    json(join(path, 'proposals.json'), proposals)
    json(join(path, 'entities.json'), entities)
    json(join(path, 'turn-snapshots.json'), turnSnapshots)
    if (workItems) json(join(path, 'work-items.json'), workItems)
    if (workInbox) json(join(path, 'work-inbox.json'), workInbox)
    if (parentTranscript) json(join(path, 'parent-transcript.json'), { items: parentTranscript, hasMore: false })
    if (skills) json(join(path, 'skills.json'), skills)
    if (earlierEpisode) json(join(path, 'earlier-episode.json'), earlierEpisode)
    json(join(path, 'checks.json'), checks)
    json(join(path, 'timing.json'), { startedAt: start, promptSentAt, turnEndedAt: endedAt, finishedAt: Date.now(), durationMs: Date.now() - start, timeoutMs: options.timeoutMs })
    const result = checks.some(check => check.result === 'fail') ? 'fail' : checks.some(check => check.result === 'review') ? 'review' : 'pass'
    json(join(path, 'result.json'), { execution, result, error })
    console.log(`${agent}/${scenario.id}: ${result} (${execution})`)
    // The returned score is independent of runner plumbing; fake-agent semantic failures are expected.
    return { agent, scenario: scenario.id, result, execution, durationMs: Date.now() - start, toolCalls: extracted.calls.length, toolErrors: extracted.errors.length, checks, ...(error ? { error } : {}) }
  }
}

export async function main(args: string[], root: string) {
  if (args.includes('--help')) {
    console.log('Usage: pnpm --filter @vis/web agent-eval --data-dir <fresh-path> [--agents codex,deepseek] [--scenarios G1,S2] [--out <fresh-path>] [--timeout-ms 1200000] [--dry-run]')
    return
  }
  const options = parseOptions(args, scenarios.map(scenario => scenario.id))
  const studiodPath = join(root, 'services/studiod/dist/studiod.mjs')
  if (!existsSync(studiodPath) || !existsSync(join(root, 'apps/cli/dist/vis.mjs'))) throw new Error('Run pnpm build before agent-eval')
  prepareDirectories(options)
  const abort = new AbortController()
  const interrupt = () => abort.abort()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const checkAbort = () => { if (abort.signal.aborted) throw new Error('Evaluation interrupted') }
  let daemon: ChildProcessWithoutNullStreams | undefined
  let daemonExited: Promise<void> | undefined
  let link: StudiodLink | undefined
  let log = ''
  let failure: string | undefined
  const events: SpaceEvent[] = []
  const results: Result[] = []
  let metadata: Record<string, unknown> = {
    options, startedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  }
  try {
    metadata = { ...metadata, versions: versions(options) }
    json(join(options.out, 'metadata.json'), metadata)
    json(join(options.dataDir, 'providers.json'), {
      providers: [],
      defaults: { image: { provider: 'mock', model: 'mock-image-1' }, video: { provider: 'mock', model: 'mock-video-1' }, audio: { provider: 'mock', model: 'mock-music-1' } },
      limits: { maxConcurrent: 1, dailyImage: 1, dailyVideo: 1, dailyAudio: 1 },
    })
    assertMockConfiguration(JSON.parse(readFileSync(join(options.dataDir, 'providers.json'), 'utf8')))
    const env: NodeJS.ProcessEnv = { ...process.env, VIS_DATA_DIR: options.dataDir, VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'), VIS_PROJECTS_DIR: options.projectsDir }
    if (options.dryRun) env.VIS_CODEX_PATH = join(root, 'apps/web/e2e/fake-codex.mjs')
    daemon = spawn(process.execPath, [studiodPath], { cwd: root, env, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' })
    daemon.stdin.end()
    daemon.stdout?.on('data', data => { log += data.toString() })
    daemon.stderr?.on('data', data => { log += data.toString() })
    let exited = false
    let spawnError: Error | undefined
    daemonExited = new Promise(resolve => {
      daemon!.once('error', error => {
        spawnError = error
        exited = true
        resolve()
      })
      daemon!.once('close', () => {
        exited = true
        resolve()
      })
    })
    const startupDeadline = Date.now() + 30_000
    for (;;) {
      checkAbort()
      assertMockConfiguration(JSON.parse(readFileSync(join(options.dataDir, 'providers.json'), 'utf8')))
      if (exited) throw new Error(spawnError ? message(spawnError) : 'studiod exited before connecting; see studiod.log')
      try {
        link = await bounded(openStudiodLink({ socketPath: studiodEndpoint(options.dataDir), tokenPath: join(options.dataDir, 'run/studiod.token'), onMessage: line => {
          const notification = JSON.parse(line)
          if (notification.method === 'events.event' && !events.some(event => event.seq === notification.params.seq)) events.push(notification.params)
        } }), 3000, abort.signal)
        break
      } catch (error) {
        if (Date.now() >= startupDeadline) throw error
        await pause(100)
      }
    }
    const call: Call = (method, params) => {
      checkAbort()
      return bounded(link!.call(method, params), 10_000, abort.signal)
    }
    const providers = await call('providers.list', {})
    assertFreeProviders(providers)
    json(join(options.out, 'providers.json'), providers)
    for (const agent of options.agents) for (const id of options.scenarios) {
      checkAbort()
      assertMockConfiguration(JSON.parse(readFileSync(join(options.dataDir, 'providers.json'), 'utf8')))
      assertFreeProviders(await call('providers.list', {}))
      const result = await scenarioRun(options, agent, scenarios.find(scenario => scenario.id === id)!, call, events, checkAbort, root)
      results.push(result)
      writeSummary(options, results, metadata)
      if (result.execution === 'error') throw new Error(result.error ?? 'Scenario runner failed')
    }
  } catch (error) {
    failure = message(error)
    process.exitCode = 1
  } finally {
    let shutdown = 'not_started'
    if (daemon && daemonExited) {
      try { if (link && !link.closed) await bounded(link.call('runtime.shutdown', { reason: 'user_quit' }), 3000) } catch {}
      try {
        await bounded(daemonExited, 5000)
        shutdown = 'exited'
      }
      catch {
        await terminateOwnedDaemon(daemon, 'SIGTERM')
        try {
          await bounded(daemonExited, 3000)
          shutdown = 'sigterm'
        } catch {
          await terminateOwnedDaemon(daemon, 'SIGKILL')
          await bounded(daemonExited, 5000)
          shutdown = 'sigkill'
        }
      }
    }
    link?.close()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    writeFileSync(join(options.out, 'studiod.log'), log, { mode: 0o600 })
    json(join(options.out, 'shutdown.json'), { pid: daemon?.pid, shutdown, exitCode: daemon?.exitCode, signalCode: daemon?.signalCode, finishedAt: new Date().toISOString() })
    writeSummary(options, results, metadata, failure)
  }
  console.log(`Evaluation report: ${join(options.out, 'report.md')}`)
  if (failure) throw new Error(failure)
}

async function terminateOwnedDaemon(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') await killTree(child, signal)
  else if (child.pid) {
    // A private process group lets fallback cleanup include agent/MCP children if the daemon cannot dispose them.
    try { process.kill(-child.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
}
