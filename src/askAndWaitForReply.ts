import { abortableSleep } from "./abort.ts"
import { RESPONSE_POLL_MS } from "./constants.ts"
import {
  AskTimeoutError,
  NoResponseError,
  SessionNotFoundError,
} from "./types.ts"

/**
 * Polling-based send-and-wait. No SSE event stream — opencode 1.17.10's
 * TUI daemons don't reliably yield `session.idle` events to plugins.
 *
 * Algorithm:
 * 1. Record `sentAt`.
 * 2. Send via `client.session.promptAsync`.
 * 3. Poll `client.session.messages` every RESPONSE_POLL_MS, filtering
 *    for `role === "assistant" && time.created >= sentAt`.
 * 4. Return the latest matching message's text, or timeout/abort.
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
      throwOnError?: boolean
      responseStyle?: string
    }): Promise<void>
    messages(args: {
      path: { id: string }
      throwOnError?: boolean
      responseStyle?: string
    }): Promise<AskClientMessage[]>
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
  const sentAt = Date.now()

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

  const deadline = sentAt + opts.timeoutMs
  while (true) {
    if (opts.abort?.aborted) {
      const e = new Error("Aborted")
      e.name = "AbortError"
      throw e
    }

    await abortableSleep(RESPONSE_POLL_MS, opts.abort)

    if (Date.now() >= deadline) {
      throw new AskTimeoutError(targetSessionId, opts.timeoutMs)
    }

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
    if (candidates.length === 0) continue

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
    if (text.length === 0) continue
    return text
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
