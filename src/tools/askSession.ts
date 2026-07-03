import { tool } from "@opencode-ai/plugin/tool"
import { askAndWaitForReply, type AskClient } from "../askAndWaitForReply.ts"
import {
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
} from "../constants.ts"
import { log } from "../logger.ts"
import { readRegistry } from "../registry.ts"
import {
  AskTimeoutError,
  NoResponseError,
  SessionNotFoundError,
} from "../types.ts"

/**
 * Given the target's daemon URL, produce a client aimed at that daemon.
 * Production wiring uses `createOpencodeClient` from the SDK; tests
 * inject a fake that ignores the URL and returns a canned client.
 */
export type AskClientFactory = (serverUrl: string) => AskClient

export function createAskSessionTool(
  makeClient: AskClientFactory,
): ReturnType<typeof tool> {
  return tool({
    description: [
      "Send a self-contained question to ANOTHER opencode session and wait for its AI-generated reply.",
      "The target session CANNOT see your conversation history — include ALL necessary context",
      "(background, code snippets, constraints) in the `question` text itself.",
      "If the target is busy, this tool waits (bounded) for it to become idle.",
      "On any failure, returns a clear error string. This tool NEVER throws.",
    ].join(" "),
    args: {
      sessionId: tool.schema
        .string()
        .min(1)
        .describe("Target session ID (obtain from `list_sessions`)."),
      question: tool.schema
        .string()
        .min(5)
        .max(20_000)
        .describe(
          "The full self-contained question. Include background, code snippets, constraints — " +
            "the target session sees ONLY this text, nothing from your own conversation history.",
        ),
      timeoutMs: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Total reply-wait budget in ms. Default ${DEFAULT_ASK_TIMEOUT_MS}, hard-clamped to ${MAX_ASK_TIMEOUT_MS}.`,
        ),
    },
    async execute(args, ctx) {
      if (args.sessionId === ctx.sessionID) {
        return {
          title: "self-ask forbidden",
          output:
            `ask_session error: cannot ask yourself (sessionId ${args.sessionId} is this session). ` +
            `Use list_sessions to find a different target.`,
        }
      }

      const budget = Math.min(
        args.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
        MAX_ASK_TIMEOUT_MS,
      )

      let targetServerUrl: string
      try {
        const reg = await readRegistry()
        const entry = reg.sessions[args.sessionId]
        if (!entry) {
          return {
            title: "not in registry",
            output:
              `ask_session error: session ${args.sessionId} is not in the registry. ` +
              `It may have exited or never registered. Call list_sessions to see current active sessions.`,
          }
        }
        if (!entry.serverUrl) {
          return {
            title: "target has no serverUrl",
            output:
              `ask_session error: session ${args.sessionId} was registered by an older plugin version ` +
              `that did not record its daemon URL. Ask the target session to call register_session again.`,
          }
        }
        targetServerUrl = entry.serverUrl
      } catch (err: unknown) {
        log.warn("ask_session:registry-read-fail", { error: String(err) })
        return {
          title: "registry read error",
          output:
            `ask_session error: could not read the shared registry: ${
              err instanceof Error ? err.message : String(err)
            }. The registry file may be corrupt.`,
        }
      }

      // Build a client aimed at the TARGET's daemon, not our own.
      const targetClient = makeClient(targetServerUrl)

      try {
        const reply = await askAndWaitForReply(
          targetClient,
          args.sessionId,
          args.question,
          { timeoutMs: budget, abort: ctx.abort },
        )
        log.info("ask_session:ok", {
          sessionId: args.sessionId,
          replyChars: reply.length,
        })
        return reply
      } catch (err: unknown) {
        return renderError(args.sessionId, err)
      }
    },
  })
}

function renderError(
  sessionId: string,
  err: unknown,
): { title: string; output: string } {
  if (err instanceof SessionNotFoundError) {
    return {
      title: "session not found",
      output:
        `ask_session error: session ${sessionId} was found in the registry but its daemon reports the session does not exist ` +
        `(may have been deleted mid-flight, or the daemon may have restarted). ` +
        `Call list_sessions to refresh — stale entries auto-prune within 24h.`,
    }
  }
  if (err instanceof AskTimeoutError) {
    return {
      title: "reply timeout",
      output:
        `ask_session error: session ${sessionId} did not respond within ${err.timeoutMs}ms. ` +
        `The target may be busy with a long-running task, or its LLM may be stuck. ` +
        `Try again with a larger timeoutMs (max ${MAX_ASK_TIMEOUT_MS}).`,
    }
  }
  if (err instanceof NoResponseError) {
    return {
      title: "no assistant reply",
      output:
        `ask_session error: session ${sessionId} produced an empty reply. ` +
        `The prompt may have errored on their side.`,
    }
  }
  const errName =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: unknown }).name)
      : ""
  if (errName === "AbortError") {
    return {
      title: "aborted",
      output: `ask_session error: the ask was aborted (either by tool cancellation or user interrupt).`,
    }
  }
  const errMsg = err instanceof Error ? err.message : String(err)
  log.warn("ask_session:unknown-error", { sessionId, error: errMsg })
  return {
    title: "unexpected error",
    output: `ask_session error: unexpected error contacting session ${sessionId}: ${errMsg}`,
  }
}
