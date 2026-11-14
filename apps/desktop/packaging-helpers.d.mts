export const visLauncher: string
export function desktopVersion(value: unknown): string
export function packageManagerInvocation(executable: string, args: string[], node?: string): { command: string; args: string[] }
export function assertStagedTarget<T extends { platform: string; arch: string; electronVersion: string }>(staged: T, requested?: { platform: string; arch: string }): T
export function assertShellAsarContents(files: string[]): void
