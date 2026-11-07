import type { ErrorCode, RevisionConflict } from '@vis/protocol'

/** Business error; the gateway maps it to a JSON-RPC error (data.code is code) */
export class VisError extends Error {
  static of(
    code: ErrorCode,
    reason: string,
    params: Record<string, string | number>,
    message: string,
    conflicts?: RevisionConflict[],
    quota?: { kind: 'image' | 'video' | 'audio'; count: number; limit: number },
    details?: Record<string, unknown>,
  ): VisError {
    return new VisError(code, message, conflicts, quota, { ...details, reason, params })
  }

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly conflicts?: RevisionConflict[],
    readonly quota?: { kind: 'image' | 'video' | 'audio'; count: number; limit: number },
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'VisError'
  }
}
