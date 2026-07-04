import { randomUUID } from "node:crypto"
import { RELAY_RECONNECT_MAX_MS, RELAY_RECONNECT_MS } from "../constants.ts"
import type { ClientMessage, ServerMessage } from "../relay/protocol.ts"
import { AskTimeoutError } from "../types.ts"
import type { RegistryEntry } from "../types.ts"
import type { InboxHandler, ITransport } from "./interface.ts"

type ConnState = "disconnected" | "connecting" | "connected"

interface Pending {
  resolve: (msg: ServerMessage) => void
  reject: (err: Error) => void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class RelayTransport implements ITransport {
  private ws: WebSocket | null = null
  private state: ConnState = "disconnected"
  private connectPromise: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = RELAY_RECONNECT_MS
  private disposed = false

  private pending = new Map<string, Pending>()
  private pendingRegister = new Map<string, Pending>()
  private pendingUnregister = new Map<string, Pending>()

  private registeredEntries = new Map<
    string,
    Omit<RegistryEntry, "registeredAt" | "updatedAt">
  >()
  private inboxHandler: InboxHandler | null = null

  constructor(private readonly relayUrl: string) {}

  async register(
    entry: Omit<RegistryEntry, "registeredAt" | "updatedAt">,
  ): Promise<RegistryEntry> {
    await this.ensureConnected()
    this.registeredEntries.set(entry.sessionId, entry)

    return new Promise<RegistryEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRegister.delete(entry.sessionId)
        reject(new Error(`register(${entry.sessionId}) timed out`))
      }, DEFAULT_REQUEST_TIMEOUT_MS)

      this.pendingRegister.set(entry.sessionId, {
        resolve: (msg) => {
          clearTimeout(timer)
          if (msg.type === "registered") {
            resolve(msg.entry)
          } else if (msg.type === "error") {
            reject(new Error(msg.message))
          } else {
            reject(new Error(`Unexpected response: ${msg.type}`))
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      try {
        this.send({ type: "register", ...entry })
      } catch (err) {
        this.pendingRegister.delete(entry.sessionId)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async list(): Promise<RegistryEntry[]> {
    await this.ensureConnected()
    const requestId = randomUUID()

    return new Promise<RegistryEntry[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error("list() timed out"))
      }, DEFAULT_REQUEST_TIMEOUT_MS)

      this.pending.set(requestId, {
        resolve: (msg) => {
          clearTimeout(timer)
          if (msg.type === "sessions") {
            resolve(msg.entries)
          } else if (msg.type === "error") {
            reject(new Error(msg.message))
          } else {
            reject(new Error(`Unexpected response: ${msg.type}`))
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      try {
        this.send({ type: "list", requestId })
      } catch (err) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async remove(sessionId: string): Promise<boolean> {
    await this.ensureConnected()
    this.registeredEntries.delete(sessionId)

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUnregister.delete(sessionId)
        reject(new Error(`remove(${sessionId}) timed out`))
      }, DEFAULT_REQUEST_TIMEOUT_MS)

      this.pendingUnregister.set(sessionId, {
        resolve: (msg) => {
          clearTimeout(timer)
          if (msg.type === "unregistered") {
            resolve(msg.removed)
          } else if (msg.type === "error") {
            reject(new Error(msg.message))
          } else {
            reject(new Error(`Unexpected response: ${msg.type}`))
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      try {
        this.send({ type: "unregister", sessionId })
      } catch (err) {
        this.pendingUnregister.delete(sessionId)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async lookup(sessionId: string): Promise<RegistryEntry | null> {
    await this.ensureConnected()
    const requestId = randomUUID()

    return new Promise<RegistryEntry | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`lookup(${sessionId}) timed out`))
      }, DEFAULT_REQUEST_TIMEOUT_MS)

      this.pending.set(requestId, {
        resolve: (msg) => {
          clearTimeout(timer)
          if (msg.type === "looked-up") {
            resolve(msg.entry)
          } else if (msg.type === "error") {
            reject(new Error(msg.message))
          } else {
            reject(new Error(`Unexpected response: ${msg.type}`))
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      try {
        this.send({ type: "lookup", requestId, sessionId })
      } catch (err) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async ask(params: {
    requestId: string
    toSessionId: string
    question: string
    timeoutMs: number
    abort?: AbortSignal
  }): Promise<{ reply?: string; error?: string }> {
    await this.ensureConnected()
    const { requestId, toSessionId, question, timeoutMs, abort } = params

    return new Promise<{ reply?: string; error?: string }>((resolve, reject) => {
      let abortListener: (() => void) | null = null
      const removeAbortListener = () => {
        if (abortListener && abort) {
          abort.removeEventListener("abort", abortListener)
          abortListener = null
        }
      }

      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        removeAbortListener()
        reject(new AskTimeoutError(toSessionId, timeoutMs))
      }, timeoutMs)

      this.pending.set(requestId, {
        resolve: (msg) => {
          clearTimeout(timer)
          removeAbortListener()
          if (msg.type === "reply") {
            resolve({ reply: msg.reply, error: msg.error })
          } else if (msg.type === "error") {
            reject(new Error(msg.message))
          } else {
            reject(new Error(`Unexpected response: ${msg.type}`))
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          removeAbortListener()
          reject(err)
        },
      })

      if (abort) {
        if (abort.aborted) {
          this.pending.delete(requestId)
          clearTimeout(timer)
          reject(new Error("Aborted"))
          return
        }
        abortListener = () => {
          this.pending.delete(requestId)
          clearTimeout(timer)
          reject(new Error("Aborted"))
        }
        abort.addEventListener("abort", abortListener, { once: true })
      }

      try {
        this.send({
          type: "ask",
          requestId,
          toSessionId,
          question,
          timeoutMs,
        })
      } catch (err) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        removeAbortListener()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  startInbox(handler: InboxHandler): void {
    this.inboxHandler = handler
    this.ensureConnected().catch(() => {
      /* reconnect loop retries */
    })
  }

  async stopInbox(): Promise<void> {
    this.inboxHandler = null
  }

  async dispose(): Promise<void> {
    this.disposed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const err = new Error("Transport disposed")
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    for (const p of this.pendingRegister.values()) p.reject(err)
    this.pendingRegister.clear()
    for (const p of this.pendingUnregister.values()) p.reject(err)
    this.pendingUnregister.clear()

    this.inboxHandler = null
    this.registeredEntries.clear()

    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.state = "disconnected"
    this.connectPromise = null
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Transport disposed"))
    if (this.state === "connected") return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.doConnect()
    return this.connectPromise
  }

  private doConnect(): Promise<void> {
    this.state = "connecting"
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(this.relayUrl)
      } catch (err) {
        this.state = "disconnected"
        this.connectPromise = null
        this.scheduleReconnect()
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.ws = ws

      let settled = false

      const onOpen = () => {
        settled = true
        this.state = "connected"
        this.reconnectDelay = RELAY_RECONNECT_MS
        for (const entry of this.registeredEntries.values()) {
          try {
            ws.send(JSON.stringify({ type: "register", ...entry }))
          } catch {
            /* ignore - onClose will handle */
          }
        }
        resolve()
      }

      const onError = () => {
        if (!settled) {
          settled = true
          reject(new Error(`Failed to connect to relay at ${this.relayUrl}`))
        }
      }

      const onClose = () => {
        this.state = "disconnected"
        this.ws = null
        this.connectPromise = null

        const err = new Error("WebSocket disconnected")
        for (const p of this.pending.values()) p.reject(err)
        this.pending.clear()
        for (const p of this.pendingRegister.values()) p.reject(err)
        this.pendingRegister.clear()
        for (const p of this.pendingUnregister.values()) p.reject(err)
        this.pendingUnregister.clear()

        if (!settled) {
          settled = true
          reject(err)
        }

        if (!this.disposed) {
          this.scheduleReconnect()
        }
      }

      const onMessage = (event: MessageEvent) => {
        this.handleMessage(event.data)
      }

      ws.addEventListener("open", onOpen)
      ws.addEventListener("error", onError)
      ws.addEventListener("close", onClose)
      ws.addEventListener("message", onMessage)
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    if (this.registeredEntries.size === 0 && !this.inboxHandler) return

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      RELAY_RECONNECT_MAX_MS,
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      this.ensureConnected().catch(() => {
        /* scheduleReconnect fires again from onClose */
      })
    }, delay)
  }

  private send(msg: ClientMessage): void {
    if (!this.ws || this.state !== "connected") {
      throw new Error("WebSocket not connected")
    }
    this.ws.send(JSON.stringify(msg))
  }

  private trySend(msg: ClientMessage): void {
    if (!this.ws || this.state !== "connected") return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {
      /* ignore */
    }
  }

  private handleMessage(data: unknown): void {
    let text: string
    if (typeof data === "string") {
      text = data
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data)
    } else if (data instanceof Uint8Array) {
      text = new TextDecoder().decode(data)
    } else {
      return
    }

    let msg: ServerMessage
    try {
      msg = JSON.parse(text) as ServerMessage
    } catch {
      return
    }

    switch (msg.type) {
      case "registered": {
        const p = this.pendingRegister.get(msg.sessionId)
        if (p) {
          this.pendingRegister.delete(msg.sessionId)
          p.resolve(msg)
        }
        return
      }
      case "unregistered": {
        const p = this.pendingUnregister.get(msg.sessionId)
        if (p) {
          this.pendingUnregister.delete(msg.sessionId)
          p.resolve(msg)
        }
        return
      }
      case "sessions":
      case "looked-up":
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
      this.trySend({
        type: "reply",
        requestId: msg.requestId,
        error: "No inbox handler registered",
      })
      return
    }
    try {
      const reply = await handler(msg.toSessionId, msg.question, {
        timeoutMs: msg.timeoutMs,
      })
      this.trySend({ type: "reply", requestId: msg.requestId, reply })
    } catch (err) {
      const errmsg = err instanceof Error ? err.message : String(err)
      this.trySend({ type: "reply", requestId: msg.requestId, error: errmsg })
    }
  }
}
