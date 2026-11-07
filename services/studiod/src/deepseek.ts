import { dirname, join } from 'node:path'
import { createDeepseekRuntime, deepseekDescriptor } from '@vis/agent-deepseek'
import { issueAgentToken } from './auth'
import type { AgentRuntimeFactory } from './space-host'

/** Connect the DeepSeek Harness adapter to a space: tokens are issued per space, with a fixed working directory per session and capabilities exposed via vis mcp. */
export function deepseekRuntime(opts: { socketPath: string; dataDir?: string; env?: NodeJS.ProcessEnv; visMcp: { command: string; args: string[] }; dshPath?: string; model?: string }): AgentRuntimeFactory {
  const factory: AgentRuntimeFactory = ({ spaceId, dir, db, workDir, report, requestApproval, forbiddenPaths }) => createDeepseekRuntime({ db, report, requestApproval }, {
    socketPath: opts.socketPath,
    ...(forbiddenPaths ? { forbiddenPaths } : {}),
    dataDir: opts.dataDir ?? dirname(dirname(opts.socketPath)),
    ...(opts.env ? { env: opts.env } : {}),
    visMcp: opts.visMcp,
    ...(opts.dshPath ? { dshPath: opts.dshPath } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    workDir,
    overlayPath: join(dir, 'agents', 'dsh-overlay.yml'),
    issueToken: () => issueAgentToken(spaceId),
  })
  return Object.assign(factory, { descriptor: deepseekDescriptor })
}
