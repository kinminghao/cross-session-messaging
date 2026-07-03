import {
  AskTimeoutError,
  NoResponseError,
  SessionNotFoundError,
} from "./types.ts"

/**
 * Send-and-wait-for-response. Rewritten after a real-daemon smoke test
 * revealed the executable plan's SDK assumptions were wrong.
 *
 * VERIFIED SDK CONTRACT (from @opencode-ai/sdk types):
 * - hey-api-generated SDK wraps responses in `{ data, error, request, response }`
 *   unless you pass BOTH `throwOnError: true` AND `responseStyle: "data"`.
 * - `client.event.subscribe()` returns `Promise<ServerSentEventsResult>`;
 *   the AsyncIterable is at `.stream`, NOT the top-level result.
 * - `client.session.status()` has NO `path` param — it returns a
 *   directory-scoped map of ALL sessions' statuses (not usable to poll one
 *   session), so this module goes fully event-driven with no status polling.
 *
 * Algorithm:
 * 1. `await client.event.subscribe({ throwOnError: true })` → iterate `.stream`.
 * 2. Record `sentAt = Date.now()`.
 * 3. Send via `client.session.promptAsync(...)` — 404 → SessionNotFoundError.
 * 4. Loop: consume events; on `session.idle` for our target, fetch messages
 *    and filter by `time.created >= sentAt`. If a matching assistant message
 *    is found, return its text. If not (this idle was for a queued turn),
 *    keep waiting for the next idle.
 * 5. Race the loop against `timeoutMs` and the caller's abort signal.
 * 6. `finally` → `iterator.return()` to close the SSE stream.
 */

export interface AskClientMessage {
  info: { role: string; time: { created: number } }
  parts: Array<{ type: string; text?: string }>
}

/**
 * Duck-typed subset of `OpencodeClient` we depend on. The real SDK client
 * structurally satisfies this — see `src/index.ts` for the cast at the
 * plugin boundary.
 */
export interface AskClient {
  session: {
    promptAsync(args: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string }> }
      throwOnError?: boolean
      responseStyle?: string
    }): Promise<void>
    messages(args: {
      path: { id: string }
      throwOnError?: boolean
      responseStyle?: string
    }): Promise<AskClientMessage[]>
  }
  event: {
    subscribe(opts?: {
      throwOnError?: boolean
    }): Promise<{ stream: AsyncIterable<unknown> }>
  }
}

export interface AskOptions {
  timeoutMs: number
  abort?: AbortSignal
}

export async function askAndWaitForReply(
  client: AskClient,
  targetSessionId: string,
  question: string,
  opts: AskOptions,
): Promise<string> {
  // Subscribe BEFORE any I/O. hey-api returns a Promise — must await.
  const subscribeResult = await client.event.subscribe({ throwOnError: true })
  const iterator = subscribeResult.stream[Symbol.asyncIterator]()

  let cleanupDone = false
  const cleanup = async (): Promise<void> => {
    if (cleanupDone) return
    cleanupDone = true
    try {
      await iterator.return?.(undefined)
    } catch {
      // Swallow cleanup errors — the primary error is already propagating.
    }
  }
  const onAbort = (): void => {
    void cleanup()
  }
  opts.abort?.addEventListener("abort", onAbort, { once: true })

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  try {
    // Capture BEFORE the send. Any assistant message with
    // `time.created >= sentAt` and `role === "assistant"` is our reply.
    const sentAt = Date.now()

    // Send. 404 here = target was deleted between our registry check and now.
    try {
      await client.session.promptAsync({
        path: { id: targetSessionId },
        body: { parts: [{ type: "text", text: question }] },
        throwOnError: true,
        responseStyle: "data",
      })
    } catch (err: unknown) {
      if (isNotFoundError(err)) throw new SessionNotFoundError(targetSessionId)
      throw err
    }

    // Loop-wait: each idle for our target triggers a message fetch. If our
    // reply isn't there yet, keep waiting for the next idle. This handles
    // the "target had a queued turn ahead of ours" case naturally.
    const replyWait = (async (): Promise<string> => {
      for (;;) {
        const step = await iterator.next()
        if (step.done) throw new Error("Event stream closed before reply")
        if (opts.abort?.aborted) throw makeAbortError()

        const ev = step.value as {
          type?: string
          properties?: { sessionID?: string }
        }
        if (ev?.type !== "session.idle") continue
        if (ev.properties?.sessionID !== targetSessionId) continue

        // Target's idle event — fetch messages and look for a reply after sentAt.
        let messages: AskClientMessage[]
        try {
          messages = await client.session.messages({
            path: { id: targetSessionId },
            throwOnError: true,
            responseStyle: "data",
          })
        } catch (err: unknown) {
          if (isNotFoundError(err)) throw new SessionNotFoundError(targetSessionId)
          throw err
        }

        const candidates = messages.filter(
          (m) => m.info.role === "assistant" && m.info.time.created >= sentAt,
        )
        if (candidates.length === 0) {
          // Idle fired without a matching assistant message. Probably a
          // queued turn that finished before ours. Keep waiting.
          continue
        }

        const last = candidates.reduce((a, b) =>
          a.info.time.created >= b.info.time.created ? a : b,
        )
        const text = last.parts
          .filter(
            (p): p is { type: "text"; text: string } =>
              p.type === "text" && typeof p.text === "string",
          )
          .map((p) => p.text)
          .join("")
        if (text.length === 0) throw new NoResponseError(targetSessionId)
        return text
      }
    })()
    // Prevent unhandledRejection if this loses the race with timeout/abort.
    replyWait.catch(() => {})

    const timeoutPromise = new Promise<never>((_, rej) => {
      timeoutTimer = setTimeout(() => {
        rej(new AskTimeoutError(targetSessionId, opts.timeoutMs))
      }, opts.timeoutMs)
      opts.abort?.addEventListener(
        "abort",
        () => {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
          rej(makeAbortError())
        },
        { once: true },
      )
    })
    timeoutPromise.catch(() => {})

    return await Promise.race([replyWait, timeoutPromise])
  } finally {
    opts.abort?.removeEventListener("abort", onAbort)
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    await cleanup()
  }
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const record = err as {
    status?: unknown
    response?: { status?: unknown }
  }
  if (record.status === 404) return true
  if (
    record.response &&
    typeof record.response === "object" &&
    record.response.status === 404
  ) {
    return true
  }
  return false
}

function makeAbortError(): Error {
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}
