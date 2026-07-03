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
  /**
   * HTTP URL of the daemon owning this session's runtime — each opencode
   * TUI runs its own daemon, so ask_session builds a client against
   * THIS URL to reach the target. Optional to preserve backwards compat
   * with pre-multi-daemon registry entries.
   */
  serverUrl?: string
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
 * Error subclasses used inside `askAndWaitForReply` for control flow.
 * The `ask_session` tool catches these and converts them to user-facing
 * text strings — the classes themselves never surface to LLM callers.
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
    super(`Session ${sessionId} produced an empty reply`)
    this.name = "NoResponseError"
  }
}
