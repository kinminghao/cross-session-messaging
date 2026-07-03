/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { PLUGIN_ID } from "./src/constants.ts"
import { listEntries } from "./src/registry.ts"
import type { RegistryEntry } from "./src/types.ts"

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

function SessionRow(props: {
  api: TuiPluginApi
  entry: RegistryEntry
  selected: boolean
  isSelf: boolean
}) {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={props.selected ? theme().primary : theme().textMuted}>
          {props.selected ? "▶" : " "}
        </text>
        <text fg={props.selected ? theme().primary : theme().text}>
          {props.entry.sessionId}
        </text>
        <Show when={props.isSelf}>
          <text fg={theme().success}>(this session)</text>
        </Show>
        <text fg={theme().textMuted}>
          {formatAge(Date.now() - props.entry.updatedAt)} ago
        </text>
      </box>
      <box flexDirection="column" paddingLeft={4}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>Summary:</text>
          <text fg={theme().text}>{props.entry.summary}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>Dir:</text>
          <text fg={theme().text}>{props.entry.directory}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>Project:</text>
          <text fg={theme().text}>{props.entry.projectId}</text>
        </box>
      </box>
    </box>
  )
}

function PeersPanel(props: {
  api: TuiPluginApi
  entries: RegistryEntry[]
  selfId?: string
}) {
  const api = props.api
  const theme = () => api.theme.current
  const [index, setIndex] = createSignal(0)

  function move(delta: number): void {
    setIndex((i) => Math.max(0, Math.min(props.entries.length - 1, i + delta)))
  }

  useKeyboard((evt) => {
    if (evt.name === "q" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      api.ui.dialog.clear()
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      move(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      move(1)
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
          <b>Peer Sessions ({props.entries.length})</b>
        </text>
        <text fg={theme().textMuted}>↑↓ navigate · esc close</text>
      </box>
      <For each={props.entries}>
        {(entry, i) => (
          <SessionRow
            api={api}
            entry={entry}
            selected={i() === index()}
            isSelf={entry.sessionId === props.selfId}
          />
        )}
      </For>
    </box>
  )
}

const plugin: TuiPluginModule = {
  id: PLUGIN_ID,
  tui: async (api) => {
    const command = api.command
    if (!command) return

    command.register(() => [
      {
        title: "Show active peer sessions",
        value: `${PLUGIN_ID}.peers`,
        category: "Sessions",
        slash: { name: "peers" },
        onSelect: async () => {
          try {
            const entries = await listEntries()
            if (entries.length === 0) {
              api.ui.toast({
                variant: "info",
                message: "No sessions are currently registered.",
              })
              return
            }
            api.ui.dialog.setSize("medium")
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
    ])
  },
}

export default plugin
