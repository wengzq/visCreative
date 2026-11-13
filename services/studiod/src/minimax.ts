import { dirname, join } from 'node:path'
import { createMinimaxRuntime, minimaxDescriptor } from '@vis/agent-minimax'
import { issueAgentToken } from './auth'
import type { AgentRuntimeFactory } from './space-host'

export function minimaxRuntime(opts: { socketPath: string; cliBinDir?: string; fallbackDirs?: readonly string[]; dataDir?: string; env?: NodeJS.ProcessEnv; visMcp: { command: string; args: string[] }; mcodePath?: string }): AgentRuntimeFactory {
  const factory: AgentRuntimeFactory = ({ spaceId, dir, db, workDir, report, requestApproval, forbiddenPaths }) => createMinimaxRuntime({ db, report, requestApproval }, {
    socketPath: opts.socketPath,
    ...(opts.cliBinDir ? { cliBinDir: opts.cliBinDir } : {}),
    ...(opts.fallbackDirs ? { fallbackDirs: opts.fallbackDirs } : {}),
    ...(forbiddenPaths ? { forbiddenPaths } : {}),
    dataDir: opts.dataDir ?? dirname(dirname(opts.socketPath)),
    ...(opts.env ? { env: opts.env } : {}),
    visMcp: opts.visMcp,
    ...(opts.mcodePath ? { mcodePath: opts.mcodePath } : {}),
    workDir,
    probeDir: join(dir, 'agents', 'minimax-probes'),
    issueToken: () => issueAgentToken(spaceId),
  })
  return Object.assign(factory, { descriptor: minimaxDescriptor })
}
