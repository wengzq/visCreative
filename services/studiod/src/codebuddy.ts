import { dirname, join } from 'node:path'
import { createCodebuddyRuntime, codebuddyDescriptor } from '@vis/agent-codebuddy'
import { issueAgentToken } from './auth'
import type { AgentRuntimeFactory } from './space-host'

export function codebuddyRuntime(opts: { socketPath: string; cliBinDir?: string; fallbackDirs?: readonly string[]; dataDir?: string; env?: NodeJS.ProcessEnv; visMcp: { command: string; args: string[] }; codebuddyPath?: string }): AgentRuntimeFactory {
  const factory: AgentRuntimeFactory = ({ spaceId, dir, db, workDir, report, requestApproval, forbiddenPaths }) => createCodebuddyRuntime({ db, report, requestApproval }, {
    socketPath: opts.socketPath,
    ...(opts.cliBinDir ? { cliBinDir: opts.cliBinDir } : {}),
    ...(opts.fallbackDirs ? { fallbackDirs: opts.fallbackDirs } : {}),
    ...(forbiddenPaths ? { forbiddenPaths } : {}),
    dataDir: opts.dataDir ?? dirname(dirname(opts.socketPath)),
    ...(opts.env ? { env: opts.env } : {}),
    visMcp: opts.visMcp,
    ...(opts.codebuddyPath ? { codebuddyPath: opts.codebuddyPath } : {}),
    workDir,
    probeDir: join(dir, 'agents', 'codebuddy-probes'),
    issueToken: () => issueAgentToken(spaceId),
  })
  return Object.assign(factory, { descriptor: codebuddyDescriptor })
}
