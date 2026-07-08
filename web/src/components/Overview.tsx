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
        <span class="stat-label">会话</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{props.clients.length}</span>
        <span class="stat-label">客户端</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{props.pendingAsks.length}</span>
        <span class="stat-label">等待中</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{deviceCount(props.sessions)}</span>
        <span class="stat-label">设备</span>
      </div>
    </div>
  )
}

function deviceCount(sessions: SessionInfo[]): number {
  return new Set(sessions.map((s) => s.deviceName ?? "unknown")).size
}
