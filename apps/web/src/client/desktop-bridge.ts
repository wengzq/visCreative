import type { MethodResult } from '@vis/protocol'
import type { RpcClient } from './rpc'

type PickResult = MethodResult<'fs.pickDirectory'>

declare global {
  interface Window {
    /** Present only inside the desktop app (RFC 0046), injected by its preload script */
    visDesktop?: { pickDirectory(defaultPath?: string): Promise<{ path?: string; cancelled: boolean }> }
  }
}

/** The desktop app shows its own folder dialog, attached to the window; the web host asks studiod to show the system one. */
export async function pickDirectory(rpc: Pick<RpcClient, 'call'>, defaultPath?: string): Promise<PickResult> {
  if (window.visDesktop) return { ...await window.visDesktop.pickDirectory(defaultPath), unsupported: false }
  return rpc.call<PickResult>('fs.pickDirectory', { ...(defaultPath ? { defaultPath } : {}) })
}
