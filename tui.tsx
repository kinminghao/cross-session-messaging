/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { execSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { hostname, networkInterfaces } from "node:os"
import { PLUGIN_ID, RELAY_DEFAULT_PORT } from "./src/constants.ts"
import { listEntries, removeEntry, upsertEntry } from "./src/registry.ts"
import type { RegistryEntry } from "./src/types.ts"
import type { RelayServer } from "./src/relay/server.ts"
import {
  clearRelayUrl,
  getRelayHistory,
  getRelayUrl,
  writeRelayUrl,
} from "./src/config.ts"

let activeRelay: RelayServer | null = null

interface PeerGroup {
  device: string
  count: number
}

const [relayInfo, setRelayInfo] = createSignal<{
  port: number
  localIp: string
  peers: PeerGroup[]
} | null>(null)

const [clientInfo, setClientInfo] = createSignal<{
  url: string
  peers: PeerGroup[]
} | null>(null)

let relayPollTimer: ReturnType<typeof setInterval> | null = null
let clientPollTimer: ReturnType<typeof setInterval> | null = null

function startRelayPolling(): void {
  if (relayPollTimer) return
  updateRelayInfo()
  relayPollTimer = setInterval(updateRelayInfo, 2_000)
}

function stopRelayPolling(): void {
  if (relayPollTimer) {
    clearInterval(relayPollTimer)
    relayPollTimer = null
  }
  setRelayInfo(null)
}

function updateRelayInfo(): void {
  if (!activeRelay) {
    setRelayInfo(null)
    return
  }
  setRelayInfo({
    port: activeRelay.port,
    localIp: getLocalIp(),
    peers: activeRelay.peersByDevice,
  })
}

function startClientPolling(): void {
  if (clientPollTimer) return
  updateClientInfo()
  clientPollTimer = setInterval(updateClientInfo, 3_000)
}

function stopClientPolling(): void {
  if (clientPollTimer) {
    clearInterval(clientPollTimer)
    clientPollTimer = null
  }
  setClientInfo(null)
}

function updateClientInfo(): void {
  const url = getRelayUrl()
  if (!url) {
    setClientInfo(null)
    return
  }
  fetch(`${url}/stats`)
    .then((res) => res.json() as Promise<{ peers: PeerGroup[] }>)
    .then((data) => setClientInfo({ url, peers: data.peers }))
    .catch(() => setClientInfo({ url, peers: [] }))
}

function getLocalIp(): string {
  const nets = networkInterfaces()
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address
    }
  }
  return "0.0.0.0"
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

function copyToClipboard(text: string): boolean {
  try {
    const cmd =
      process.platform === "darwin"
        ? "pbcopy"
        : process.platform === "linux"
          ? "xclip -selection clipboard"
          : process.platform === "win32"
            ? "clip"
            : undefined
    if (!cmd) return false
    execSync(cmd, { input: text, stdio: ["pipe", "ignore", "ignore"] })
    return true
  } catch {
    return false
  }
}

function formatSessionInfo(entry: RegistryEntry): string {
  return [
    `Use the ask_session tool to communicate with this peer session:`,
    ``,
    `- Session ID: ${entry.sessionId}`,
    `- Summary: ${entry.summary}`,
    `- Directory: ${entry.directory}`,
    `- Project: ${entry.projectId}`,
    entry.deviceName ? `- Device: ${entry.deviceName}` : "",
    ``,
    `ask_session(sessionId="${entry.sessionId}", question="<your self-contained question here>")`,
    ``,
    `IMPORTANT: The target session CANNOT see your conversation history.`,
    `Include ALL necessary context (background, code snippets, constraints) in the question text itself.`,
  ]
    .filter(Boolean)
    .join("\n")
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function shortDir(dir: string): string {
  const parts = dir.split("/")
  return parts.length <= 3 ? dir : `…/${parts.slice(-2).join("/")}`
}

function SessionRow(props: {
  api: TuiPluginApi
  entry: RegistryEntry
  selected: boolean
  expanded: boolean
  isSelf: boolean
  isRemote: boolean
  confirming?: boolean
}) {
  const theme = () => props.api.theme.current
  const e = props.entry
  const arrow = () =>
    props.selected ? (props.expanded ? "▼" : "▶") : " "
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={props.selected ? theme().primary : theme().textMuted}>
          {arrow()}
        </text>
        <text fg={props.selected ? theme().primary : theme().text}>
          {truncate(e.summary || e.sessionId, 40)}
        </text>
        <Show when={props.isSelf}>
          <text fg={theme().success}>★</text>
        </Show>
        <text fg={theme().textMuted}>{shortDir(e.directory)}</text>
        <text fg={theme().textMuted}>
          {formatAge(Date.now() - e.updatedAt)}
        </text>
        <Show when={props.confirming}>
          <text fg={theme().error}>⚠ delete?</text>
        </Show>
      </box>
      <Show when={props.expanded}>
        <box flexDirection="column" paddingLeft={4}>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>ID:</text>
            <text fg={theme().text}>{e.sessionId}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>Summary:</text>
            <text fg={theme().text}>{e.summary}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>Dir:</text>
            <text fg={theme().text}>{e.directory}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>Project:</text>
            <text fg={theme().text}>{e.projectId}</text>
          </box>
          <Show when={e.deviceName}>
            <box flexDirection="row" gap={1}>
              <text fg={theme().textMuted}>Device:</text>
              <text fg={theme().text}>{e.deviceName}</text>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

async function deleteSession(sessionId: string): Promise<void> {
  const relayUrl = getRelayUrl()
  if (relayUrl) {
    const res = await fetch(`${relayUrl}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: `tui-delete-${randomUUID().slice(0, 8)}`,
        sessionId,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }
  await removeEntry(sessionId)
}

function PeersPanel(props: {
  api: TuiPluginApi
  entries: RegistryEntry[]
  selfId?: string
}) {
  const api = props.api
  const theme = () => api.theme.current
  const localDevice = hostname()
  const [entries, setEntries] = createSignal(props.entries)
  const [tabIndex, setTabIndex] = createSignal(0)
  const [rowIndex, setRowIndex] = createSignal(0)
  const [expandedIds, setExpandedIds] = createSignal<Set<string>>(new Set())
  const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(
    null,
  )

  function toggleExpand(sessionId: string, force?: boolean): void {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      const shouldExpand = force ?? !next.has(sessionId)
      if (shouldExpand) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }

  function devices() {
    const seen = new Map<string, RegistryEntry[]>()
    for (const e of entries()) {
      const dev = e.deviceName ?? "unknown"
      const arr = seen.get(dev)
      if (arr) arr.push(e)
      else seen.set(dev, [e])
    }
    return [...seen.entries()].map(([name, items]) => ({ name, items }))
  }

  function currentTab() {
    const devs = devices()
    return devs[tabIndex()] ?? devs[0]
  }

  function switchTab(delta: number): void {
    const devs = devices()
    if (devs.length === 0) return
    setTabIndex((i) => ((i + delta) % devs.length + devs.length) % devs.length)
    setRowIndex(0)
    setConfirmingDelete(null)
  }

  function moveRow(delta: number): void {
    const tab = currentTab()
    if (!tab) return
    setConfirmingDelete(null)
    setRowIndex((i) => Math.max(0, Math.min(tab.items.length - 1, i + delta)))
  }

  useKeyboard((evt) => {
    if (evt.name === "q" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      api.ui.dialog.clear()
      return
    }
    if (evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      switchTab(evt.shift ? -1 : 1)
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      moveRow(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      moveRow(1)
      return
    }
    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      evt.stopPropagation()
      const tab = currentTab()
      const entry = tab?.items[rowIndex()]
      if (entry) toggleExpand(entry.sessionId, true)
      return
    }
    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      evt.stopPropagation()
      const tab = currentTab()
      const entry = tab?.items[rowIndex()]
      if (entry) toggleExpand(entry.sessionId, false)
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      setConfirmingDelete(null)
      const tab = currentTab()
      const entry = tab?.items[rowIndex()]
      if (!entry) return
      const text = formatSessionInfo(entry)
      if (copyToClipboard(text)) {
        api.ui.toast({
          variant: "success",
          message: `Copied session info for ${entry.sessionId}`,
        })
      } else {
        api.ui.toast({
          variant: "error",
          message: "Failed to copy to clipboard.",
        })
      }
      return
    }
    if (evt.name === "backspace" || evt.name === "delete") {
      evt.preventDefault()
      evt.stopPropagation()
      const tab = currentTab()
      const entry = tab?.items[rowIndex()]
      if (!entry) return
      if (confirmingDelete() === entry.sessionId) {
        void (async () => {
          try {
            await deleteSession(entry.sessionId)
            const updated = entries().filter(
              (e) => e.sessionId !== entry.sessionId,
            )
            setEntries(updated)
            setConfirmingDelete(null)
            if (updated.length === 0) {
              api.ui.dialog.clear()
              api.ui.toast({
                variant: "info",
                message: "No sessions remaining.",
              })
              return
            }
            const newTab = (() => {
              const devs = [...new Map(
                updated.map((e) => [e.deviceName ?? "unknown", true]),
              ).keys()]
              if (tabIndex() >= devs.length) setTabIndex(devs.length - 1)
              return devs[tabIndex()]
            })()
            const tabItems = updated.filter(
              (e) => (e.deviceName ?? "unknown") === newTab,
            )
            setRowIndex((i) => Math.min(i, Math.max(0, tabItems.length - 1)))
            api.ui.toast({
              variant: "success",
              message: `Removed session ${entry.sessionId}`,
            })
          } catch (error) {
            setConfirmingDelete(null)
            api.ui.toast({
              variant: "error",
              message: `Failed to remove: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        })()
      } else {
        setConfirmingDelete(entry.sessionId)
      }
      return
    }
  })

  return (
    <box
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      flexDirection="column"
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Peer Sessions ({entries().length})</b>
        </text>
        <text fg={theme().textMuted}>
          tab switch · ↑↓ navigate · ←→ fold · ⏎ copy · ⌫ del · esc
        </text>
      </box>

      <box flexDirection="row" gap={2}>
        <For each={devices()}>
          {(dev, di) => {
            const isActive = () => di() === tabIndex()
            const isLocal = dev.name === localDevice
            return (
              <text
                fg={isActive() ? theme().primary : theme().textMuted}
              >
                {isActive() ? "▸ " : "  "}
                {isLocal ? `${dev.name} (local)` : dev.name}
                {` (${dev.items.length})`}
              </text>
            )
          }}
        </For>
      </box>

      <box flexDirection="column" overflow="scroll" maxHeight={20}>
        <For each={currentTab()?.items ?? []}>
          {(entry, ri) => (
            <SessionRow
              api={api}
              entry={entry}
              selected={ri() === rowIndex()}
              expanded={expandedIds().has(entry.sessionId)}
              isSelf={entry.sessionId === props.selfId}
              isRemote={
                !!entry.deviceName && entry.deviceName !== localDevice
              }
              confirming={confirmingDelete() === entry.sessionId}
            />
          )}
        </For>
      </box>
    </box>
  )
}

function RelayStatusPanel(props: {
  api: TuiPluginApi
  port: number
  localIp: string
}) {
  const api = props.api
  const theme = () => api.theme.current

  const [peers, setPeers] = createSignal(activeRelay?.peersByDevice ?? [])
  const timer = setInterval(() => {
    if (activeRelay) setPeers(activeRelay.peersByDevice)
  }, 1_000)
  onCleanup(() => clearInterval(timer))

  useKeyboard((evt) => {
    if (evt.name === "q" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      api.ui.dialog.clear()
      return
    }
    if (evt.name === "s") {
      evt.preventDefault()
      evt.stopPropagation()
      if (activeRelay) {
        activeRelay.stop()
        activeRelay = null
        stopRelayPolling()
        stopClientPolling()
        void clearRelayUrl()
        api.ui.dialog.clear()
        api.ui.toast({ variant: "info", message: "Relay server stopped." })
      }
      return
    }
    if (evt.name === "c") {
      evt.preventDefault()
      evt.stopPropagation()
      const url = `http://${props.localIp}:${props.port}`
      if (copyToClipboard(url)) {
        api.ui.toast({ variant: "success", message: `Copied: ${url}` })
      }
      return
    }
  })

  return (
    <box
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      flexDirection="column"
    >
      <text fg={theme().text}>
        <b>Relay Server</b>
      </text>
      <box flexDirection="column" paddingLeft={2} gap={0}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>Listen:</text>
          <text fg={theme().primary}>
            http://{props.localIp}:{props.port}
          </text>
        </box>
      </box>
      <Show when={peers().length > 0}>
        <box flexDirection="column" paddingLeft={2} paddingTop={1}>
          <For each={peers()}>
            {(pg) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme().text}>{pg.device}</text>
                <text fg={theme().textMuted}>
                  ({pg.count} {pg.count === 1 ? "peer" : "peers"})
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <text fg={theme().textMuted}>c copy URL · s stop · esc close</text>
      <box paddingTop={1}>
        <text fg={theme().textMuted}>
          On other machines: /join http://{props.localIp}:{props.port}
        </text>
      </box>
    </box>
  )
}



const plugin: TuiPluginModule = {
  id: PLUGIN_ID,
  tui: async (api) => {
    const command = api.command
    if (!command) return

    startClientPolling()
    api.lifecycle.onDispose(() => {
      stopClientPolling()
      stopRelayPolling()
    })

    api.slots.register({
      slots: {
        sidebar_title: (ctx) => {
          const server = relayInfo()
          const client = clientInfo()
          if (!server && !client) return <></>
          const theme = ctx.theme.current
          const peers = server?.peers ?? client?.peers ?? []
          const totalPeers = peers.reduce((s, p) => s + p.count, 0)
          return (
            <box flexDirection="column" paddingLeft={1} paddingBottom={1}>
              <Show when={server}>
                <text fg={theme.primary}>
                  <b>⚡ Relay :{server!.port}</b>
                </text>
                <text fg={theme.textMuted}>
                  http://{server!.localIp}:{server!.port}
                </text>
              </Show>
              <Show when={!server && client}>
                <text fg={theme.primary}>
                  <b>⚡ Relay</b>
                </text>
                <text fg={theme.textMuted}>{client!.url}</text>
              </Show>
              <Show
                when={peers.length > 0}
                fallback={
                  <text fg={theme.textMuted}>
                    {server ? "waiting for peers..." : "no peers"}
                  </text>
                }
              >
                <text fg={theme.text}>
                  {totalPeers} {totalPeers === 1 ? "peer" : "peers"}
                </text>
                <box flexDirection="column" paddingLeft={2}>
                  <For each={peers}>
                    {(pg) => (
                      <text fg={theme.textMuted}>
                        {pg.device} ({pg.count})
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          )
        },
      },
    })

    command.register(() => [
      {
        title: "Show active peer sessions",
        value: `${PLUGIN_ID}.peers`,
        category: "Sessions",
        slash: { name: "peers" },
        onSelect: async () => {
          try {
            let entries: RegistryEntry[]
            const relayUrl = getRelayUrl()
            if (relayUrl) {
              const res = await fetch(`${relayUrl}/api/list`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientId: `tui-peers-${randomUUID().slice(0, 8)}`,
                  requestId: randomUUID(),
                }),
              })
              const data = (await res.json()) as {
                entries?: RegistryEntry[]
              }
              entries = data.entries ?? []
            } else {
              entries = await listEntries()
            }
            if (entries.length === 0) {
              api.ui.toast({
                variant: "info",
                message: "No sessions are currently registered.",
              })
              return
            }
            api.ui.dialog.setSize("large")
            api.ui.dialog.replace(() => (
              <PeersPanel api={api} entries={entries} />
            ))
          } catch (error) {
            api.ui.toast({
              variant: "error",
              message: `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        },
      },
      {
        title: "Register current session",
        value: `${PLUGIN_ID}.register`,
        category: "Sessions",
        slash: { name: "register" },
        onSelect: async () => {
          const route = api.route.current
          if (route.name !== "session") {
            api.ui.toast({
              variant: "warning",
              message: "Navigate to a session first.",
            })
            return
          }
          const sessionID = route.params?.sessionID as string
          const session = api.state.session.get(sessionID)
          const defaultSummary = session?.title ?? ""
          api.ui.dialog.setSize("medium")
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Register Session"
              placeholder="e.g. refactoring OAuth in src/auth/oauth.ts"
              value={defaultSummary}
              onConfirm={async (summary: string) => {
                api.ui.dialog.clear()
                const trimmed = summary.trim()
                if (trimmed.length < 5) {
                  api.ui.toast({
                    variant: "warning",
                    message: "Summary must be at least 5 characters.",
                  })
                  return
                }
                try {
                  await upsertEntry({
                    sessionId: sessionID,
                    summary: trimmed,
                    directory: api.state.path.directory,
                    projectId: api.state.path.worktree,
                  })
                  api.ui.toast({
                    variant: "success",
                    message: `Session registered: ${trimmed}`,
                  })
                } catch (error) {
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to register: ${error instanceof Error ? error.message : String(error)}`,
                  })
                }
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        title: "Start/stop relay server",
        value: `${PLUGIN_ID}.relay`,
        category: "Sessions",
        slash: { name: "relay" },
        onSelect: async () => {
          if (activeRelay) {
            const localIp = getLocalIp()
            api.ui.dialog.setSize("medium")
            api.ui.dialog.replace(() => (
              <RelayStatusPanel
                api={api}
                port={activeRelay!.port}
                localIp={localIp}
              />
            ))
            return
          }

          api.ui.dialog.setSize("medium")
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Start Relay Server"
              placeholder={`Port (default: ${RELAY_DEFAULT_PORT})`}
              value={String(RELAY_DEFAULT_PORT)}
              onConfirm={async (portStr: string) => {
                api.ui.dialog.clear()
                const port =
                  parseInt(portStr.trim(), 10) || RELAY_DEFAULT_PORT
                if (port < 1024 || port > 65535) {
                  api.ui.toast({
                    variant: "error",
                    message: "Port must be between 1024 and 65535.",
                  })
                  return
                }
                try {
                  const { RelayServer } = await import(
                    "./src/relay/server.ts"
                  )
                  activeRelay = new RelayServer(port)
                  activeRelay.start()
                  startRelayPolling()
                  const localIp = getLocalIp()
                  const selfUrl = `http://127.0.0.1:${port}`
                  await writeRelayUrl(selfUrl)
                  startClientPolling()
                  api.ui.toast({
                    variant: "success",
                    message: `Relay started on http://${localIp}:${port}`,
                  })
                } catch (error) {
                  activeRelay = null
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to start relay: ${error instanceof Error ? error.message : String(error)}`,
                  })
                }
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        title: "Join a relay server",
        value: `${PLUGIN_ID}.join`,
        category: "Sessions",
        slash: { name: "join" },
        onSelect: async () => {
          const history = getRelayHistory()

          const doJoin = async (url: string) => {
            api.ui.dialog.clear()
            const trimmed = url.trim()
            if (
              !trimmed.startsWith("http://") &&
              !trimmed.startsWith("https://")
            ) {
              api.ui.toast({
                variant: "error",
                message: "URL must start with http:// or https://",
              })
              return
            }
            try {
              await writeRelayUrl(trimmed)
              api.ui.toast({
                variant: "success",
                message: `Connecting to ${trimmed}...`,
              })
            } catch (error) {
              api.ui.toast({
                variant: "error",
                message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
              })
            }
          }

          if (history.length > 0) {
            const options = [
              ...history.map((url) => ({
                title: url,
                value: url,
                description: "Reconnect",
              })),
              {
                title: "Enter new URL...",
                value: "__new__",
                description: "Join a different relay",
              },
            ]
            api.ui.dialog.setSize("medium")
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Join Relay"
                options={options}
                onSelect={(opt) => {
                  if (opt.value === "__new__") {
                    api.ui.dialog.replace(() => (
                      <api.ui.DialogPrompt
                        title="Join Relay"
                        placeholder="http://192.168.1.100:7351"
                        onConfirm={(url: string) => void doJoin(url)}
                        onCancel={() => api.ui.dialog.clear()}
                      />
                    ))
                  } else {
                    void doJoin(opt.value as string)
                  }
                }}
              />
            ))
          } else {
            api.ui.dialog.setSize("medium")
            api.ui.dialog.replace(() => (
              <api.ui.DialogPrompt
                title="Join Relay"
                placeholder="ws://192.168.1.100:7351"
                onConfirm={(url: string) => void doJoin(url)}
                onCancel={() => api.ui.dialog.clear()}
              />
            ))
          }
        },
      },
    ])
  },
}

export default plugin
