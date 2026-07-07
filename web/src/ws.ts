import type { DashboardEvent, Snapshot } from "./types"

type EventCallback = (event: DashboardEvent) => void
type StatusCallback = (connected: boolean) => void

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000

export function createRelayConnection(opts: {
  onEvent: EventCallback
  onStatus: StatusCallback
}) {
  let ws: WebSocket | null = null
  let reconnectMs = RECONNECT_BASE_MS
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function getWsUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${location.host}/ws`
  }

  function connect() {
    if (disposed) return
    try {
      ws = new WebSocket(getWsUrl())
    } catch {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      reconnectMs = RECONNECT_BASE_MS
      opts.onStatus(true)
    }

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as DashboardEvent
        opts.onEvent(event)
      } catch { }
    }

    ws.onclose = () => {
      opts.onStatus(false)
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  function scheduleReconnect() {
    if (disposed) return
    reconnectTimer = setTimeout(() => {
      reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS)
      connect()
    }, reconnectMs)
  }

  function dispose() {
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
    ws = null
  }

  connect()
  return { dispose }
}
