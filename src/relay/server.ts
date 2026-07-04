import type { Server } from "bun"
import { RELAY_DEFAULT_PORT, STALE_ENTRY_TTL_MS } from "../constants.ts"
import type { RegistryEntry } from "../types.ts"
import type { ServerMessage } from "./protocol.ts"

const CLIENT_STALE_MS = 30_000
const CLEANUP_INTERVAL_MS = 10_000

interface PendingAsk {
  callerClientId: string
  targetSessionId: string
}

export class RelayServer {
  readonly port: number
  private server: Server<undefined> | null = null
  private readonly sessions = new Map<string, RegistryEntry>()
  private readonly sessionToClient = new Map<string, string>()
  private readonly clientToSessions = new Map<string, Set<string>>()
  private readonly clientLastSeen = new Map<string, number>()
  private readonly clientIps = new Map<string, string>()
  private readonly clientQueues = new Map<string, ServerMessage[]>()
  private readonly pendingAsks = new Map<string, PendingAsk>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(port: number = RELAY_DEFAULT_PORT) {
    this.port = port
  }

  get connectedClients(): number {
    const cutoff = Date.now() - CLIENT_STALE_MS
    let count = 0
    for (const ts of this.clientLastSeen.values()) {
      if (ts >= cutoff) count++
    }
    return count
  }

  get clientDetails(): Array<{ ip: string; sessions: string[] }> {
    const cutoff = Date.now() - CLIENT_STALE_MS
    const details: Array<{ ip: string; sessions: string[] }> = []
    for (const [cid, ts] of this.clientLastSeen) {
      if (ts < cutoff) continue
      const sids = this.clientToSessions.get(cid)
      details.push({
        ip: this.clientIps.get(cid) ?? "unknown",
        sessions: sids ? [...sids] : [],
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
      fetch: (req, server) => this.handleRequest(req, server),
    })
    this.cleanupTimer = setInterval(
      () => this.cleanupStaleClients(),
      CLEANUP_INTERVAL_MS,
    )
    console.log(`[relay] listening on 0.0.0.0:${this.port}`)
  }

  stop(): void {
    if (!this.server) return
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.server.stop(true)
    this.server = null
    this.sessions.clear()
    this.sessionToClient.clear()
    this.clientToSessions.clear()
    this.clientLastSeen.clear()
    this.clientIps.clear()
    this.clientQueues.clear()
    this.pendingAsks.clear()
    console.log("[relay] stopped")
  }

  private async handleRequest(
    req: Request,
    server: Server<undefined>,
  ): Promise<Response> {
    try {
      const url = new URL(req.url)
      const path = url.pathname

      if (path === "/stats" && req.method === "GET") {
        return Response.json({ peers: this.peersByDevice })
      }

      if (path === "/api/poll" && req.method === "GET") {
        const clientId = url.searchParams.get("clientId")
        if (!clientId) {
          return Response.json(
            { error: "clientId required" },
            { status: 400 },
          )
        }
        this.touchClient(clientId, req, server)
        return this.handlePoll(clientId)
      }

      if (req.method !== "POST") {
        return Response.json(
          { error: "method not allowed" },
          { status: 405 },
        )
      }

      let body: Record<string, unknown>
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        return Response.json(
          { error: "invalid JSON body" },
          { status: 400 },
        )
      }

      const clientId = body.clientId as string | undefined
      if (!clientId) {
        return Response.json(
          { error: "clientId required" },
          { status: 400 },
        )
      }

      this.touchClient(clientId, req, server)

      switch (path) {
        case "/api/register":
          return this.handleRegister(clientId, body)
        case "/api/unregister":
          return this.handleUnregister(clientId, body)
        case "/api/list":
          return this.handleList(body)
        case "/api/lookup":
          return this.handleLookup(body)
        case "/api/ask":
          return this.handleAsk(clientId, body)
        case "/api/reply":
          return this.handleReply(body)
        default:
          return Response.json({ error: "not found" }, { status: 404 })
      }
    } catch (err) {
      console.error(`[relay] request error: ${(err as Error).message}`)
      return Response.json(
        { error: `internal error: ${(err as Error).message}` },
        { status: 500 },
      )
    }
  }

  private touchClient(
    clientId: string,
    req: Request,
    server: Server<undefined>,
  ): void {
    this.clientLastSeen.set(clientId, Date.now())
    try {
      const addr = server.requestIP(req)
      if (addr) this.clientIps.set(clientId, addr.address)
    } catch {
      /* ignore */
    }
    if (!this.clientToSessions.has(clientId)) {
      this.clientToSessions.set(clientId, new Set())
    }
    if (!this.clientQueues.has(clientId)) {
      this.clientQueues.set(clientId, [])
    }
  }

  private handlePoll(clientId: string): Response {
    const queue = this.clientQueues.get(clientId)
    if (!queue || queue.length === 0) {
      return Response.json({ messages: [] })
    }
    const messages = [...queue]
    queue.length = 0
    return Response.json({ messages })
  }

  private handleRegister(
    clientId: string,
    body: Record<string, unknown>,
  ): Response {
    const sessionId = body.sessionId as string
    const now = Date.now()
    const existing = this.sessions.get(sessionId)
    const entry: RegistryEntry = {
      sessionId,
      summary: body.summary as string,
      directory: body.directory as string,
      projectId: body.projectId as string,
      serverUrl: body.serverUrl as string | undefined,
      daemonId: body.daemonId as string | undefined,
      deviceName: body.deviceName as string | undefined,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    }

    const oldOwner = this.sessionToClient.get(sessionId)
    if (oldOwner && oldOwner !== clientId) {
      this.clientToSessions.get(oldOwner)?.delete(sessionId)
    }

    this.sessions.set(sessionId, entry)
    this.sessionToClient.set(sessionId, clientId)
    const owned = this.clientToSessions.get(clientId) ?? new Set<string>()
    owned.add(sessionId)
    this.clientToSessions.set(clientId, owned)

    console.log(
      `[relay] registered ${sessionId} (client=${clientId.slice(0, 8)})`,
    )
    return Response.json({ type: "registered", sessionId, entry })
  }

  private handleUnregister(
    clientId: string,
    body: Record<string, unknown>,
  ): Response {
    const sessionId = body.sessionId as string
    const existed = this.sessions.delete(sessionId)
    this.sessionToClient.delete(sessionId)
    this.clientToSessions.get(clientId)?.delete(sessionId)
    return Response.json({
      type: "unregistered",
      sessionId,
      removed: existed,
    })
  }

  private handleList(body: Record<string, unknown>): Response {
    const requestId = body.requestId as string
    const cutoff = Date.now() - STALE_ENTRY_TTL_MS
    const entries = [...this.sessions.values()]
      .filter((e) => e.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return Response.json({ type: "sessions", requestId, entries })
  }

  private handleLookup(body: Record<string, unknown>): Response {
    const requestId = body.requestId as string
    const sessionId = body.sessionId as string
    const entry = this.sessions.get(sessionId) ?? null
    return Response.json({ type: "looked-up", requestId, entry })
  }

  private handleAsk(
    clientId: string,
    body: Record<string, unknown>,
  ): Response {
    const requestId = body.requestId as string
    const toSessionId = body.toSessionId as string
    const question = body.question as string
    const timeoutMs = body.timeoutMs as number

    const targetClientId = this.sessionToClient.get(toSessionId)
    if (!targetClientId) {
      return Response.json({
        ok: false,
        error: `Target session ${toSessionId} not found`,
      })
    }

    const callerSessions = this.clientToSessions.get(clientId)
    const fromSessionId: string =
      callerSessions?.values().next().value ?? "unknown"

    this.pendingAsks.set(requestId, {
      callerClientId: clientId,
      targetSessionId: toSessionId,
    })

    this.enqueue(targetClientId, {
      type: "inbound",
      requestId,
      fromSessionId,
      toSessionId,
      question,
      timeoutMs,
    })

    return Response.json({ ok: true })
  }

  private handleReply(body: Record<string, unknown>): Response {
    const requestId = body.requestId as string
    const reply = body.reply as string | undefined
    const error = body.error as string | undefined

    const pending = this.pendingAsks.get(requestId)
    if (!pending) {
      return Response.json({ ok: true })
    }

    this.pendingAsks.delete(requestId)
    this.enqueue(pending.callerClientId, {
      type: "reply",
      requestId,
      reply,
      error,
    })

    return Response.json({ ok: true })
  }

  private enqueue(clientId: string, msg: ServerMessage): void {
    let queue = this.clientQueues.get(clientId)
    if (!queue) {
      queue = []
      this.clientQueues.set(clientId, queue)
    }
    queue.push(msg)
  }

  private cleanupStaleClients(): void {
    const cutoff = Date.now() - CLIENT_STALE_MS
    for (const [clientId, lastSeen] of this.clientLastSeen) {
      if (lastSeen >= cutoff) continue

      const owned = this.clientToSessions.get(clientId) ?? new Set()
      for (const sid of owned) {
        this.sessions.delete(sid)
        this.sessionToClient.delete(sid)
      }

      for (const [reqId, pending] of this.pendingAsks) {
        if (pending.callerClientId === clientId) {
          this.pendingAsks.delete(reqId)
        } else if (owned.has(pending.targetSessionId)) {
          this.enqueue(pending.callerClientId, {
            type: "reply",
            requestId: reqId,
            error: `Target session ${pending.targetSessionId} disconnected`,
          })
          this.pendingAsks.delete(reqId)
        }
      }

      this.clientToSessions.delete(clientId)
      this.clientLastSeen.delete(clientId)
      this.clientIps.delete(clientId)
      this.clientQueues.delete(clientId)

      console.log(
        `[relay] cleaned up stale client ${clientId.slice(0, 8)} (${owned.size} sessions)`,
      )
    }
  }
}
