import { For, Show } from "solid-js"
import type { SessionInfo } from "../types"

export function SessionsPanel(props: { sessions: SessionInfo[] }) {
  return (
    <section class="panel sessions-panel">
      <h2>活跃会话 ({props.sessions.length})</h2>
      <Show when={props.sessions.length > 0} fallback={<p class="empty">暂无注册会话</p>}>
        <div class="session-list">
          <For each={props.sessions}>
            {(session) => <SessionCard session={session} />}
          </For>
        </div>
      </Show>
    </section>
  )
}

function SessionCard(props: { session: SessionInfo }) {
  const age = () => formatAge(Date.now() - props.session.updatedAt)

  return (
    <div class="session-card">
      <div class="session-header">
        <code class="session-id">{props.session.sessionId.slice(0, 12)}...</code>
        <span class="session-device">{props.session.deviceName ?? "本机"}</span>
      </div>
      <p class="session-summary">{props.session.summary}</p>
      <div class="session-meta">
        <span title={props.session.directory}>{shortenPath(props.session.directory)}</span>
        <span>{age()}</span>
      </div>
    </div>
  )
}

function shortenPath(path: string): string {
  const parts = path.split("/")
  if (parts.length <= 3) return path
  return `.../${parts.slice(-2).join("/")}`
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
  return `${Math.floor(ms / 3_600_000)} 小时前`
}
