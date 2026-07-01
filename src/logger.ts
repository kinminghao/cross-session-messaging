import type { PluginInput } from "@opencode-ai/plugin"
import { PLUGIN_ID } from "./constants.ts"

type Client = PluginInput["client"]
type Level = "debug" | "info" | "warn" | "error"

// Held so future migrations to opencode's structured logger (writes to
// ~/.local/share/opencode/log/opencode.log) can pull the SDK client without
// touching every call-site.
let client: Client | null = null

/** Attach the in-process opencode SDK client. Called once from `src/index.ts`. */
export function initLogger(c: Client): void {
  client = c
}

/**
 * Emit a log line. Every line is prefixed with PLUGIN_ID so the whole
 * plugin's activity is greppable in `opencode.log`.
 *
 * TODO(scaffold): the opencode plugin API doesn't expose a `client.log.*`
 * surface as of @opencode-ai/plugin@1.17.x, so this writes to stderr for
 * now — the opencode daemon captures stderr into its logfile. Revisit if
 * a first-class logging hook lands.
 */
function emit(level: Level, tag: string, extra?: unknown): void {
  const payload = extra === undefined ? "" : ` ${safeStringify(extra)}`
  const line = `${PLUGIN_ID}: ${tag}${payload}`
  const fn: (...args: unknown[]) => void =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "debug"
          ? console.debug
          : console.log
  fn(`[${level}] ${line}`)
  void client // reserved for structured-log migration
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const log = {
  debug: (tag: string, extra?: unknown): void => emit("debug", tag, extra),
  info: (tag: string, extra?: unknown): void => emit("info", tag, extra),
  warn: (tag: string, extra?: unknown): void => emit("warn", tag, extra),
  error: (tag: string, extra?: unknown): void => emit("error", tag, extra),
}
