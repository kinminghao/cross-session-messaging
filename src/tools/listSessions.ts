import { tool } from "@opencode-ai/plugin/tool"
import { listEntries } from "../registry.ts"
import { log } from "../logger.ts"

/**
 * `list_sessions` — return live registry entries so the calling LLM
 * can pick a target for `ask_session`. Corresponds to executable plan §T12.
 *
 * Stale filtering (`updatedAt` older than 24h) is done inside
 * `listEntries` — the tool receives already-filtered, already-sorted data.
 */
export function createListSessionsTool(): ReturnType<typeof tool> {
  return tool({
    description: [
      "List active peer sessions in the registry, most recent first.",
      "Excludes YOUR own session by default (pass includeSelf=true to include).",
      "Stale entries (>24h since last update) are filtered automatically.",
      "Use before `ask_session` to discover a target by summary.",
    ].join(" "),
    args: {
      includeSelf: tool.schema
        .boolean()
        .optional()
        .describe("If true, include this session's own entry. Default false."),
    },
    async execute(args, ctx) {
      try {
        const entries = await listEntries()
        const filtered = args.includeSelf
          ? entries
          : entries.filter((e) => e.sessionId !== ctx.sessionID)
        if (filtered.length === 0) {
          return { title: "0 sessions", output: "No sessions registered." }
        }
        const now = Date.now()
        const lines = filtered.map((e, i) => {
          const age = formatAge(now - e.updatedAt)
          return (
            `${i + 1}. **${e.sessionId}** [project ${e.projectId}]\n` +
            `   Directory: ${e.directory}\n` +
            `   Summary: ${e.summary}\n` +
            `   Updated: ${age} ago`
          )
        })
        return {
          title: `${filtered.length} session(s)`,
          output: `Active sessions (${filtered.length}):\n\n${lines.join("\n\n")}`,
        }
      } catch (error) {
        log.warn("list_sessions:fail", { error: String(error) })
        return {
          title: "list failed",
          output: `list_sessions failed: ${String(error)}`,
        }
      }
    },
  })
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}
