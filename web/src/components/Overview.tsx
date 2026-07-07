import type { ClientInfo, PendingAskInfo, SessionInfo } from "../types"

export function Overview(props: {
  sessions: SessionInfo[]
  clients: ClientInfo[]
  pendingAsks: PendingAskInfo[]
}) {
  return (
    <div class="overview">
      <div class="stat-card">
        <span class="stat-value">{props.sessions.length}</span>
        <span class="stat-label">Sessions</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{props.clients.length}</span>
        <span class="stat-label">Clients</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{props.pendingAsks.length}</span>
        <span class="stat-label">Pending Asks</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{deviceCount(props.sessions)}</span>
        <span class="stat-label">Devices</span>
      </div>
    </div>
  )
}

function deviceCount(sessions: SessionInfo[]): number {
  return new Set(sessions.map((s) => s.deviceName ?? "unknown")).size
}
