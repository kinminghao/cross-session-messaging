import { abortableSleep } from "./abort.ts"
import {
  POLL_BACKOFF_FACTOR,
  POLL_INITIAL_DELAY_MS,
  POLL_MAX_DELAY_MS,
} from "./constants.ts"
import { IdleWaitTimeoutError, SessionNotFoundError } from "./types.ts"

/**
 * Bounded exponential-backoff poll on `client.session.status(...)` until
 * the target session reports `type: "idle"`. Corresponds to executable
 * plan §T8.
 *
 * Duck-typed on `client` so tests can inject a fake without pulling in
 * the whole opencode SDK. The real caller passes the SDK client, which
 * satisfies this interface.
 */
export interface StatusClient {
  session: {
    status(args: { path: { id: string } }): Promise<{ type: string }>
  }
}

export interface WaitForIdleOptions {
  /** Total budget in ms; throws `IdleWaitTimeoutError` when exceeded. */
  timeoutMs: number
  /** Cancellation signal; throws AbortError promptly if fires. */
  abort?: AbortSignal
  /** Override for `POLL_INITIAL_DELAY_MS` (tests use short values). */
  initialDelayMs?: number
  /** Override for `POLL_MAX_DELAY_MS`. */
  maxDelayMs?: number
  /** Override for `POLL_BACKOFF_FACTOR`. */
  backoffFactor?: number
}

/**
 * Resolve once `session.status` returns `{ type: "idle" }`.
 *
 * Error taxonomy:
 * - `SessionNotFoundError` — status call returns HTTP 404 (session was
 *   deleted between registration and now).
 * - `IdleWaitTimeoutError` — total elapsed exceeds `timeoutMs` without
 *   ever seeing idle.
 * - `Error` with `name === "AbortError"` — abort signal fired.
 * - Other errors from `session.status` propagate unchanged.
 *
 * Any non-idle status (including `busy` and `retry`) is treated as
 * "keep polling" — `retry` is not special-cased.
 */
export async function waitForIdle(
  client: StatusClient,
  sessionId: string,
  opts: WaitForIdleOptions,
): Promise<void> {
  const start = Date.now()
  const initial = opts.initialDelayMs ?? POLL_INITIAL_DELAY_MS
  const max = opts.maxDelayMs ?? POLL_MAX_DELAY_MS
  const factor = opts.backoffFactor ?? POLL_BACKOFF_FACTOR
  let delay = initial

  while (true) {
    if (opts.abort?.aborted) throw makeAbortError()

    let status: { type: string }
    try {
      status = await client.session.status({ path: { id: sessionId } })
    } catch (err: unknown) {
      if (isNotFoundError(err)) throw new SessionNotFoundError(sessionId)
      throw err
    }

    if (status.type === "idle") return

    if (Date.now() - start >= opts.timeoutMs) {
      throw new IdleWaitTimeoutError(sessionId, opts.timeoutMs)
    }

    // Sleep before next poll. abortableSleep short-circuits on abort.
    await abortableSleep(delay, opts.abort)
    delay = Math.min(delay * factor, max)
  }
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const record = err as { status?: unknown; response?: { status?: unknown } }
  if (record.status === 404) return true
  if (record.response && typeof record.response === "object") {
    if (record.response.status === 404) return true
  }
  return false
}

function makeAbortError(): Error {
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}
