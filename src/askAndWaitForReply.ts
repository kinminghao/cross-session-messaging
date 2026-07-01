import {
  AskTimeoutError,
  NoResponseError,
  SessionNotFoundError,
} from "./types.ts"

/**
 * Send-and-wait-for-response. Corresponds to executable plan §T9 —
 * the trickiest module in the pipeline.
 *
 * Duck-typed on `client` so tests can inject an in-memory fake without
 * pulling the whole opencode SDK. The real opencode client satisfies
 * this interface.
 */
export interface AskClientMessage {
  info: { role: string; time: { created: number } }
  parts: Array<{ type: string; text?: string }>
}

export interface AskClient {
  session: {
    promptAsync(args: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string }> }
    }): Promise<void>
    messages(args: {
      path: { id: string }
    }): Promise<{ messages: AskClientMessage[] }>
  }
  event: {
    subscribe(): AsyncIterable<unknown>
  }
}

export interface AskOptions {
  timeoutMs: number
  abort?: AbortSignal
}

/**
 * Send `question` to the target session and wait for its next
 * assistant reply. Resolves with the reply's concatenated text.
 *
 * Failure modes (all throw — the calling tool catches and converts to
 * user-facing text):
 * - `SessionNotFoundError` — target returns HTTP 404 on `promptAsync`
 *   or `messages` (session deleted mid-flight).
 * - `AskTimeoutError` — total elapsed exceeds `timeoutMs` without a
 *   target-scoped `session.idle` event.
 * - `NoResponseError` — idle event received, but `messages` has no
 *   assistant message with `time.created >= sentAt`.
 * - `Error` with `name === "AbortError"` — abort signal fired.
 * - Event stream error — propagated unchanged.
 *
 * Cleanup: on ALL exit paths, `iterator.return?.()` is called to
 * unsubscribe from the event stream. Idempotent.
 */
export async function askAndWaitForReply(
  client: AskClient,
  targetSessionId: string,
  question: string,
  opts: AskOptions,
): Promise<string> {
  // Subscribe BEFORE sending — a very fast target may emit `session.idle`
  // between our send and our subscribe if we did it the other way.
  const eventStream = client.event.subscribe()
  const iterator = eventStream[Symbol.asyncIterator]() as AsyncIterator<unknown>

  let cleanupDone = false
  const cleanup = async (): Promise<void> => {
    if (cleanupDone) return
    cleanupDone = true
    try {
      await iterator.return?.()
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
    // Capture BEFORE the send. A message with `time.created >= sentAt`
    // and `role === "assistant"` is our reply. Pitfall (Metis-flagged):
    // capturing AFTER the send could miss a target that replies within
    // the same millisecond.
    const sentAt = Date.now()

    // Send. 404 here means the target was deleted between our earlier
    // registry check and now — surface as SessionNotFoundError.
    try {
      await client.session.promptAsync({
        path: { id: targetSessionId },
        body: { parts: [{ type: "text", text: question }] },
      })
    } catch (err: unknown) {
      if (isNotFoundError(err)) throw new SessionNotFoundError(targetSessionId)
      throw err
    }

    // Race three signals for the idle wait:
    //   (a) target-scoped session.idle event  → resolve normally
    //   (b) timeoutMs elapsed                 → reject with AskTimeoutError
    //   (c) abort signal fires                → reject with AbortError
    const idleWait = (async (): Promise<void> => {
      for (;;) {
        const step = await iterator.next()
        if (step.done) {
          throw new Error("Event stream closed before target-idle event")
        }
        if (opts.abort?.aborted) throw makeAbortError()
        const ev = step.value as {
          type?: string
          properties?: { sessionID?: string }
        }
        if (
          ev?.type === "session.idle" &&
          ev.properties?.sessionID === targetSessionId
        ) {
          return
        }
        // Any other event (idle for other sessions, message.updated, etc.) is ignored.
      }
    })()
    // If this loses the race, its later rejection would otherwise show
    // up as an unhandledRejection. Attach a no-op catch to acknowledge.
    idleWait.catch(() => {})

    const timeout = new Promise<never>((_, rej) => {
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
    timeout.catch(() => {})

    await Promise.race([idleWait, timeout])

    // Fetch messages and pick the assistant reply after `sentAt`.
    // Filtering by time is CRITICAL — target may have unrelated prior
    // assistant messages that would spoof an answer otherwise.
    let messagesResp: { messages: AskClientMessage[] }
    try {
      messagesResp = await client.session.messages({
        path: { id: targetSessionId },
      })
    } catch (err: unknown) {
      if (isNotFoundError(err)) throw new SessionNotFoundError(targetSessionId)
      throw err
    }

    const candidates = messagesResp.messages.filter(
      (m) => m.info.role === "assistant" && m.info.time.created >= sentAt,
    )
    if (candidates.length === 0) throw new NoResponseError(targetSessionId)

    // Take the LATEST candidate — one target turn typically produces one
    // final assistant message, but if streamed segments recorded as
    // separate messages, the latest is the canonical answer.
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
