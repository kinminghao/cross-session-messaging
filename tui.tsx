/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { execSync } from "node:child_process"
import { PLUGIN_ID } from "./src/constants.ts"
import { listEntries, upsertEntry } from "./src/registry.ts"
import type { RegistryEntry } from "./src/types.ts"

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
    ``,
    `ask_session(sessionId="${entry.sessionId}", question="<your self-contained question here>")`,
    ``,
    `IMPORTANT: The target session CANNOT see your conversation history.`,
    `Include ALL necessary context (background, code snippets, constraints) in the question text itself.`,
  ].join("\n")
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
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      const entry = props.entries[index()]
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
        <text fg={theme().textMuted}>↑↓ navigate · enter copy · esc close</text>
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
          const sessionID = route.params.sessionID as string
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
    ])
  },
}

export default plugin
