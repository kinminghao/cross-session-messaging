/**
 * Shared TypeScript types for the cross-session-messaging plugin.
 * Corresponds to executable plan §T2.
 *
 * Nullability note: this plugin uses strict non-null `directory` and
 * `projectId` on `RegistryEntry` because the opencode SDK guarantees
 * `ctx.directory: string` (from `ToolContext`) and `input.project.id: string`
 * (from `Project`). The plan's original type used `string | null` for both
 * because it derived `projectId` from a `.git/opencode` file that might
 * not exist; using the SDK-provided value avoids that branch entirely.
 */

export const REGISTRY_SCHEMA_VERSION = 1 as const

export interface RegistryEntry {
  sessionId: string
  summary: string
  directory: string
  projectId: string
  registeredAt: number
  updatedAt: number
}

export interface Registry {
  version: typeof REGISTRY_SCHEMA_VERSION
  sessions: Record<string, RegistryEntry>
}

export interface RegisterSessionArgs {
  summary: string
}

export interface ListSessionsArgs {
  includeSelf?: boolean
}

export interface AskSessionArgs {
  sessionId: string
  question: string
  timeoutMs?: number
}

/**
 * Distinct error subclasses for the 6-error taxonomy in `ask_session`
 * (executable plan §T13). `askSession` catches these and converts them to
 * user-facing text strings — the errors themselves are used for control flow
 * inside the core algorithm modules (`waitForIdle`, `askAndWaitForReply`).
 */

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} not found`)
    this.name = "SessionNotFoundError"
  }
}

export class AskTimeoutError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Session ${sessionId} did not respond within ${timeoutMs}ms`)
    this.name = "AskTimeoutError"
  }
}

export class NoResponseError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} went idle without emitting a reply`)
    this.name = "NoResponseError"
  }
}

export class IdleWaitTimeoutError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Session ${sessionId} did not become idle within ${timeoutMs}ms`)
    this.name = "IdleWaitTimeoutError"
  }
}
