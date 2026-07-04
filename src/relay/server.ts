import type { Server, ServerWebSocket } from "bun"
import { RELAY_DEFAULT_PORT, STALE_ENTRY_TTL_MS } from "../constants.ts"
import type { RegistryEntry } from "../types.ts"
import type { ClientMessage, ServerMessage } from "./protocol.ts"

type WS = ServerWebSocket<undefined>

interface PendingAsk {
  caller: WS
  targetSessionId: string
}

export class RelayServer {
  readonly port: number
  private server: Server<undefined> | null = null
  private readonly sessions = new Map<string, RegistryEntry>()
  private readonly sessionToWs = new Map<string, WS>()
  private readonly wsToSessions = new Map<WS, Set<string>>()
  private readonly pendingAsks = new Map<string, PendingAsk>()
  private readonly clients = new Set<WS>()

  constructor(port: number = RELAY_DEFAULT_PORT) {
    this.port = port
  }

  get connectedClients(): number {
    return this.clients.size
  }

  get clientDetails(): Array<{ ip: string; sessions: string[] }> {
    const details: Array<{ ip: string; sessions: string[] }> = []
    for (const [ws, sessionIds] of this.wsToSessions) {
      details.push({
        ip: ws.remoteAddress,
        sessions: [...sessionIds],
      })
    }
    return details
  }

  get peersByDevice(): Array<{ device: string; count: number }> {
    const counts = new Map<string, number>()
    for (const entry of this.sessions.values()) {
      const device = entry.deviceName ?? "unknown"
      counts.set(device, (counts.get(device) ?? 0) + 1)
    }
    return [...counts.entries()].map(([device, count]) => ({ device, count }))
  }

  start(): void {
    if (this.server) return
    this.server = Bun.serve({
      port: this.port,
      hostname: "0.0.0.0",
      fetch: (req, server) => {
        if (new URL(req.url).pathname === "/stats") {
          return Response.json({ peers: this.peersByDevice })
        }
        if (server.upgrade(req)) return
        return new Response("relay: websocket only", { status: 426 })
      },
      websocket: {
        open: (ws) => this.handleOpen(ws),
        message: (ws, data) => this.handleMessage(ws, data),
        close: (ws) => this.handleClose(ws),
      },
    })
    console.log(`[relay] listening on 0.0.0.0:${this.port}`)
  }

  stop(): void {
    if (!this.server) return
    this.server.stop(true)
    this.server = null
    this.sessions.clear()
    this.sessionToWs.clear()
    this.wsToSessions.clear()
    this.pendingAsks.clear()
    this.clients.clear()
    console.log("[relay] stopped")
  }

  private handleOpen(ws: WS): void {
    this.clients.add(ws)
    this.wsToSessions.set(ws, new Set<string>())
    console.log(`[relay] client connected (total=${this.clients.size})`)
  }

  private handleClose(ws: WS): void {
    const owned = this.wsToSessions.get(ws) ?? new Set<string>()
    for (const sid of owned) {
      this.sessions.delete(sid)
      this.sessionToWs.delete(sid)
    }
    this.wsToSessions.delete(ws)
    for (const [reqId, pending] of this.pendingAsks) {
      if (pending.caller === ws) {
        this.pendingAsks.delete(reqId)
      } else if (owned.has(pending.targetSessionId)) {
        this.send(pending.caller, {
          type: "reply",
          requestId: reqId,
          error: `Target session ${pending.targetSessionId} disconnected`,
        })
        this.pendingAsks.delete(reqId)
      }
    }
    this.clients.delete(ws)
    console.log(`[relay] client disconnected (total=${this.clients.size})`)
  }

  private handleMessage(ws: WS, data: string | Buffer): void {
    let msg: ClientMessage
    try {
      const text = typeof data === "string" ? data : data.toString("utf8")
      msg = JSON.parse(text) as ClientMessage
    } catch (err) {
      this.send(ws, {
        type: "error",
        message: `invalid JSON: ${(err as Error).message}`,
      })
      return
    }
    switch (msg.type) {
      case "register":
        this.onRegister(ws, msg)
        return
      case "unregister":
        this.onUnregister(ws, msg)
        return
      case "list":
        this.onList(ws, msg)
        return
      case "lookup":
        this.onLookup(ws, msg)
        return
      case "ask":
        this.onAsk(ws, msg)
        return
      case "reply":
        this.onReply(msg)
        return
      default: {
        const _exhaustive: never = msg
        void _exhaustive
      }
    }
  }

  private onRegister(
    ws: WS,
    msg: Extract<ClientMessage, { type: "register" }>,
  ): void {
    const now = Date.now()
    const existing = this.sessions.get(msg.sessionId)
    const entry: RegistryEntry = {
      sessionId: msg.sessionId,
      summary: msg.summary,
      directory: msg.directory,
      projectId: msg.projectId,
      serverUrl: msg.serverUrl,
      daemonId: msg.daemonId,
      deviceName: msg.deviceName,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    }
    const oldOwner = this.sessionToWs.get(msg.sessionId)
    if (oldOwner && oldOwner !== ws) {
      this.wsToSessions.get(oldOwner)?.delete(msg.sessionId)
    }
    this.sessions.set(msg.sessionId, entry)
    this.sessionToWs.set(msg.sessionId, ws)
    let owned = this.wsToSessions.get(ws)
    if (!owned) {
      owned = new Set<string>()
      this.wsToSessions.set(ws, owned)
    }
    owned.add(msg.sessionId)
    this.send(ws, { type: "registered", sessionId: msg.sessionId, entry })
  }

  private onUnregister(
    ws: WS,
    msg: Extract<ClientMessage, { type: "unregister" }>,
  ): void {
    const existed = this.sessions.delete(msg.sessionId)
    this.sessionToWs.delete(msg.sessionId)
    this.wsToSessions.get(ws)?.delete(msg.sessionId)
    this.send(ws, {
      type: "unregistered",
      sessionId: msg.sessionId,
      removed: existed,
    })
  }

  private onList(
    ws: WS,
    msg: Extract<ClientMessage, { type: "list" }>,
  ): void {
    const cutoff = Date.now() - STALE_ENTRY_TTL_MS
    const entries = [...this.sessions.values()]
      .filter((e) => e.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    this.send(ws, { type: "sessions", requestId: msg.requestId, entries })
  }

  private onLookup(
    ws: WS,
    msg: Extract<ClientMessage, { type: "lookup" }>,
  ): void {
    const entry = this.sessions.get(msg.sessionId) ?? null
    this.send(ws, { type: "looked-up", requestId: msg.requestId, entry })
  }

  private onAsk(
    ws: WS,
    msg: Extract<ClientMessage, { type: "ask" }>,
  ): void {
    const targetWs = this.sessionToWs.get(msg.toSessionId)
    if (!targetWs) {
      this.send(ws, {
        type: "error",
        requestId: msg.requestId,
        message: `Target session ${msg.toSessionId} not found`,
      })
      return
    }
    const owned = this.wsToSessions.get(ws)
    const first = owned?.values().next().value
    const fromSessionId: string = first ?? "unknown"
    this.pendingAsks.set(msg.requestId, {
      caller: ws,
      targetSessionId: msg.toSessionId,
    })
    this.send(targetWs, {
      type: "inbound",
      requestId: msg.requestId,
      fromSessionId,
      toSessionId: msg.toSessionId,
      question: msg.question,
      timeoutMs: msg.timeoutMs,
    })
  }

  private onReply(msg: Extract<ClientMessage, { type: "reply" }>): void {
    const pending = this.pendingAsks.get(msg.requestId)
    if (!pending) return
    this.pendingAsks.delete(msg.requestId)
    this.send(pending.caller, {
      type: "reply",
      requestId: msg.requestId,
      reply: msg.reply,
      error: msg.error,
    })
  }

  private send(ws: WS, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch (err) {
      console.error(`[relay] send failed: ${(err as Error).message}`)
    }
  }
}
