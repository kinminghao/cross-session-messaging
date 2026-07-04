import { randomUUID } from "node:crypto"
import { RELAY_HTTP_POLL_MS } from "../constants.ts"
import type { ServerMessage } from "../relay/protocol.ts"
import { AskTimeoutError } from "../types.ts"
import type { RegistryEntry } from "../types.ts"
import type { InboxHandler, ITransport } from "./interface.ts"

interface Pending {
  resolve: (msg: ServerMessage) => void
  reject: (err: Error) => void
}

export class RelayTransport implements ITransport {
  private readonly clientId = randomUUID()
  private disposed = false

  private pending = new Map<string, Pending>()
  private registeredEntries = new Map<
    string,
    Omit<RegistryEntry, "registeredAt" | "updatedAt">
  >()
  private inboxHandler: InboxHandler | null = null

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false

  constructor(private readonly relayUrl: string) {}

  async register(
    entry: Omit<RegistryEntry, "registeredAt" | "updatedAt">,
  ): Promise<RegistryEntry> {
    this.checkDisposed()
    this.registeredEntries.set(entry.sessionId, entry)

    const res = (await this.post("/api/register", {
      clientId: this.clientId,
      ...entry,
    })) as ServerMessage

    if (res.type === "registered") return res.entry
    if (res.type === "error") throw new Error(res.message)
    throw new Error(`Unexpected response: ${res.type}`)
  }

  async list(): Promise<RegistryEntry[]> {
    this.checkDisposed()
    const requestId = randomUUID()

    const res = (await this.post("/api/list", {
      clientId: this.clientId,
      requestId,
    })) as ServerMessage

    if (res.type === "sessions") return res.entries
    if (res.type === "error") throw new Error(res.message)
    throw new Error(`Unexpected response: ${res.type}`)
  }

  async remove(sessionId: string): Promise<boolean> {
    this.checkDisposed()
    this.registeredEntries.delete(sessionId)

    const res = (await this.post("/api/unregister", {
      clientId: this.clientId,
      sessionId,
    })) as ServerMessage

    if (res.type === "unregistered") return res.removed
    if (res.type === "error") throw new Error(res.message)
    throw new Error(`Unexpected response: ${res.type}`)
  }

  async lookup(sessionId: string): Promise<RegistryEntry | null> {
    this.checkDisposed()
    const requestId = randomUUID()

    const res = (await this.post("/api/lookup", {
      clientId: this.clientId,
      requestId,
      sessionId,
    })) as ServerMessage

    if (res.type === "looked-up") return res.entry
    if (res.type === "error") throw new Error(res.message)
    throw new Error(`Unexpected response: ${res.type}`)
  }

  async ask(params: {
    requestId: string
    toSessionId: string
    question: string
    timeoutMs: number
    abort?: AbortSignal
  }): Promise<{ reply?: string; error?: string }> {
    this.checkDisposed()
    this.ensurePollStarted()
    const { requestId, toSessionId, question, timeoutMs, abort } = params

    return new Promise<{ reply?: string; error?: string }>(
      (resolve, reject) => {
        let abortListener: (() => void) | null = null
        const removeAbortListener = () => {
          if (abortListener && abort) {
            abort.removeEventListener("abort", abortListener)
            abortListener = null
          }
        }

        const cleanup = () => {
          this.pending.delete(requestId)
          clearTimeout(timer)
          removeAbortListener()
        }

        const timer = setTimeout(() => {
          cleanup()
          reject(new AskTimeoutError(toSessionId, timeoutMs))
        }, timeoutMs)

        this.pending.set(requestId, {
          resolve: (msg) => {
            cleanup()
            if (msg.type === "reply") {
              resolve({ reply: msg.reply, error: msg.error })
            } else if (msg.type === "error") {
              reject(new Error(msg.message))
            } else {
              reject(new Error(`Unexpected response: ${msg.type}`))
            }
          },
          reject: (err) => {
            cleanup()
            reject(err)
          },
        })

        if (abort) {
          if (abort.aborted) {
            cleanup()
            reject(new Error("Aborted"))
            return
          }
          abortListener = () => {
            cleanup()
            reject(new Error("Aborted"))
          }
          abort.addEventListener("abort", abortListener, { once: true })
        }

        this.post("/api/ask", {
          clientId: this.clientId,
          requestId,
          toSessionId,
          question,
          timeoutMs,
        })
          .then((raw) => {
            const data = raw as { ok: boolean; error?: string }
            if (!data.ok && data.error) {
              cleanup()
              reject(new Error(data.error))
            }
          })
          .catch((err) => {
            cleanup()
            reject(err instanceof Error ? err : new Error(String(err)))
          })
      },
    )
  }

  startInbox(handler: InboxHandler): void {
    this.inboxHandler = handler
    this.ensurePollStarted()
  }

  async stopInbox(): Promise<void> {
    this.inboxHandler = null
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopPoll()

    const err = new Error("Transport disposed")
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()

    this.inboxHandler = null
    this.registeredEntries.clear()
  }

  private checkDisposed(): void {
    if (this.disposed) throw new Error("Transport disposed")
  }

  private ensurePollStarted(): void {
    if (this.pollTimer || this.disposed) return
    void this.doPoll()
    this.pollTimer = setInterval(
      () => void this.doPoll(),
      RELAY_HTTP_POLL_MS,
    )
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async doPoll(): Promise<void> {
    if (this.polling || this.disposed) return
    this.polling = true
    try {
      const res = await fetch(
        `${this.relayUrl}/api/poll?clientId=${encodeURIComponent(this.clientId)}`,
      )
      if (!res.ok) return
      const data = (await res.json()) as { messages?: ServerMessage[] }
      if (data.messages) {
        for (const msg of data.messages) {
          this.handleMessage(msg)
        }
      }
    } catch {
      // server unreachable — retry on next tick
    } finally {
      this.polling = false
    }
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetch(`${this.relayUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }
    return res.json()
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "reply": {
        const p = this.pending.get(msg.requestId)
        if (p) {
          this.pending.delete(msg.requestId)
          p.resolve(msg)
        }
        return
      }
      case "inbound": {
        void this.handleInbound(msg)
        return
      }
      case "error": {
        if (msg.requestId !== undefined) {
          const p = this.pending.get(msg.requestId)
          if (p) {
            this.pending.delete(msg.requestId)
            p.reject(new Error(msg.message))
          }
        }
        return
      }
    }
  }

  private async handleInbound(
    msg: Extract<ServerMessage, { type: "inbound" }>,
  ): Promise<void> {
    const handler = this.inboxHandler
    if (!handler) {
      await this.tryPost("/api/reply", {
        clientId: this.clientId,
        requestId: msg.requestId,
        error: "No inbox handler registered",
      })
      return
    }
    try {
      const reply = await handler(msg.toSessionId, msg.question, {
        timeoutMs: msg.timeoutMs,
      })
      await this.tryPost("/api/reply", {
        clientId: this.clientId,
        requestId: msg.requestId,
        reply,
      })
    } catch (err) {
      const errmsg = err instanceof Error ? err.message : String(err)
      await this.tryPost("/api/reply", {
        clientId: this.clientId,
        requestId: msg.requestId,
        error: errmsg,
      })
    }
  }

  private async tryPost(
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.post(path, body)
    } catch {
      /* ignore */
    }
  }
}
