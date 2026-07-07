import { For, Show } from "solid-js"
import type { ActivityEntry, PendingAskInfo } from "../types"

export function MessageFlow(props: { activity: ActivityEntry[]; pendingAsks: PendingAskInfo[] }) {
  return (
    <section class="panel message-flow">
      <h2>Activity</h2>
      <Show when={props.pendingAsks.length > 0}>
        <div class="pending-section">
          <h3>Pending ({props.pendingAsks.length})</h3>
          <For each={props.pendingAsks}>
            {(ask) => <PendingAskCard ask={ask} />}
          </For>
        </div>
      </Show>
      <div class="activity-feed">
        <Show when={props.activity.length > 0} fallback={<p class="empty">No activity yet</p>}>
          <For each={props.activity}>
            {(entry) => <ActivityCard entry={entry} />}
          </For>
        </Show>
      </div>
    </section>
  )
}

function PendingAskCard(props: { ask: PendingAskInfo }) {
  const elapsed = () => formatDuration(Date.now() - props.ask.createdAt)

  return (
    <div class="pending-ask">
      <div class="ask-header">
        <span class="ask-direction">
          {shortId(props.ask.fromSessionId)} → {shortId(props.ask.targetSessionId)}
        </span>
        <span class="ask-elapsed">{elapsed()}</span>
      </div>
      <p class="ask-preview">{props.ask.questionPreview ?? "..."}</p>
    </div>
  )
}

function ActivityCard(props: { entry: ActivityEntry }) {
  const time = () => new Date(props.entry.timestamp).toLocaleTimeString()

  return (
    <div class={`activity-entry activity-${typeCategory(props.entry.type)}`}>
      <span class="activity-time">{time()}</span>
      <span class={`activity-badge badge-${typeCategory(props.entry.type)}`}>
        {formatType(props.entry.type)}
      </span>
      <span class="activity-detail">{formatDetail(props.entry)}</span>
    </div>
  )
}

function typeCategory(type: ActivityEntry["type"]): string {
  if (type.startsWith("ask:")) return "ask"
  if (type.startsWith("session:")) return "session"
  if (type.startsWith("client:")) return "client"
  return "other"
}

function formatType(type: string): string {
  return type.replace(":", " ").replace("session ", "").replace("client ", "").replace("ask ", "")
}

function formatDetail(entry: ActivityEntry): string {
  const d = entry.data
  switch (entry.type) {
    case "session:registered":
      return `${shortId(d.sessionId as string)} registered`
    case "session:unregistered":
      return `${shortId(d.sessionId as string)} unregistered`
    case "client:connected":
      return `${shortId(d.clientId as string)} from ${d.ip}`
    case "client:disconnected":
      return `${shortId(d.clientId as string)} (${d.sessionCount} sessions)`
    case "ask:created":
      return `${shortId(d.fromSessionId as string)} → ${shortId(d.toSessionId as string)}`
    case "ask:replied":
      return `${shortId(d.requestId as string)} replied (${d.replyLen} chars, ${formatDuration(d.durationMs as number)})`
    case "ask:error":
      return `${shortId(d.requestId as string)} error: ${d.error}`
    case "ask:timeout":
      return `${shortId(d.requestId as string)} timed out`
    default:
      return JSON.stringify(d)
  }
}

function shortId(id: string): string {
  return id?.slice(0, 8) ?? "?"
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}
