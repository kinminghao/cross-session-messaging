import { For, Show } from "solid-js"
import type { ClientInfo } from "../types"

export function ClientsPanel(props: { clients: ClientInfo[] }) {
  return (
    <section class="panel clients-panel">
      <h2>Clients ({props.clients.length})</h2>
      <Show when={props.clients.length > 0} fallback={<p class="empty">No clients connected</p>}>
        <table class="clients-table">
          <thead>
            <tr>
              <th>Client ID</th>
              <th>IP</th>
              <th>Sessions</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.clients}>
              {(client) => (
                <tr>
                  <td><code>{client.clientId.slice(0, 8)}</code></td>
                  <td>{client.ip}</td>
                  <td>{client.sessions.length}</td>
                  <td>{formatAge(Date.now() - client.lastSeen)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </section>
  )
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}
