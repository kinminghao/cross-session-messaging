/**
 * All timeouts, backoff, and filesystem-layout constants for the plugin.
 * Corresponds to executable plan §T3.
 *
 * Every value that could plausibly need tuning lives here — no timeouts /
 * paths / backoff numbers are allowed to leak into other modules.
 */

/** Plugin identifier — used for log tags and future permission scoping. */
export const PLUGIN_ID = "cross-session-messaging" as const

/** Default reply-wait budget for `ask_session` (caller may override up to MAX). */
export const DEFAULT_ASK_TIMEOUT_MS = 60_000

/** Hard upper bound for `ask_session`'s `timeoutMs` argument (10 min). */
export const MAX_ASK_TIMEOUT_MS = 10 * 60_000

/**
 * Portion of the total ask budget reserved for waiting on the target to
 * become idle before we even send the prompt. Capped so we don't burn the
 * whole budget waiting.
 */
export const IDLE_WAIT_BUDGET_MS = 45_000

/** First poll interval on `session.status()`; grows by BACKOFF_FACTOR up to MAX. */
export const POLL_INITIAL_DELAY_MS = 250
export const POLL_MAX_DELAY_MS = 2_000
export const POLL_BACKOFF_FACTOR = 2

/**
 * Registry file layout. Registry path is `${stateDir}/opencode/agents-registry.json`
 * where `stateDir` is `$XDG_STATE_HOME` or `$HOME/.local/state` (see `xdg.ts`).
 */
export const REGISTRY_DIR_NAME = "opencode"
export const REGISTRY_FILENAME = "agents-registry.json"

/**
 * Registry entries older than this in `updatedAt` are hidden by
 * `list_sessions`. Defense-in-depth for a missed `session.deleted` event.
 */
export const STALE_ENTRY_TTL_MS = 24 * 60 * 60 * 1000

/** File-based cross-daemon IPC. */
export const MESSAGES_DIR_NAME = "messages"
export const RESPONSE_POLL_MS = 500
export const INBOX_POLL_MS = 1_000
export const INBOX_REQUEST_TIMEOUT_MS = 5 * 60_000

export const RELAY_DEFAULT_PORT = 7351
export const RELAY_RECONNECT_MS = 3_000
export const RELAY_RECONNECT_MAX_MS = 30_000
