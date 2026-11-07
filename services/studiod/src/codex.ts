import { dirname } from 'node:path'
import { createCodexRuntime, codexDescriptor } from '@vis/agent-codex'
import { issueAgentToken } from './auth'
import type { AgentRuntimeFactory } from './space-host'

/** Connect the Codex adapter to a space: tokens are issued per space, with a fixed working directory per session and capabilities exposed via vis mcp. */
export function codexRuntime(opts: { socketPath: string; dataDir?: string; env?: NodeJS.ProcessEnv; visMcp: { command: string; args: string[] }; codexPath?: string; model?: string }): AgentRuntimeFactory {
  const factory: AgentRuntimeFactory = ({ spaceId, db, workDir, report, stream, requestApproval, forbiddenPaths }) => createCodexRuntime({ db, report, stream, requestApproval }, {
    socketPath: opts.socketPath,
    ...(forbiddenPaths ? { forbiddenPaths } : {}),
    dataDir: opts.dataDir ?? dirname(dirname(opts.socketPath)),
    ...(opts.env ? { env: opts.env } : {}),
    visMcp: opts.visMcp,
    ...(opts.codexPath ? { codexPath: opts.codexPath } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    workDir,
    issueToken: () => issueAgentToken(spaceId),
  })
  return Object.assign(factory, { descriptor: codexDescriptor })
}
