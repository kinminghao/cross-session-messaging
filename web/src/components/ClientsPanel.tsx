import { For, Show } from "solid-js"
import type { ClientInfo } from "../types"

export function ClientsPanel(props: { clients: ClientInfo[] }) {
  return (
    <section class="panel clients-panel">
      <h2>客户端连接 ({props.clients.length})</h2>
      <Show when={props.clients.length > 0} fallback={<p class="empty">暂无客户端连接</p>}>
        <table class="clients-table">
          <thead>
            <tr>
              <th>客户端</th>
              <th>地址</th>
              <th>会话数</th>
              <th>最后心跳</th>
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
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
  return `${Math.floor(ms / 3_600_000)} 小时前`
}
