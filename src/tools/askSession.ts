import { tool } from "@opencode-ai/plugin/tool"
import { randomUUID } from "node:crypto"
import {
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
} from "../constants.ts"
import {
  cleanupRequest,
  pollForResponse,
  writeRequest,
} from "../fileTransport.ts"
import { log } from "../logger.ts"
import { readRegistry } from "../registry.ts"
import { AskTimeoutError } from "../types.ts"

export function createAskSessionTool(): ReturnType<typeof tool> {
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
        if (!entry.daemonId) {
          return {
            title: "target has no daemonId",
            output:
              `ask_session error: session ${args.sessionId} was registered by an older plugin version ` +
              `that did not record its daemon identity. Ask the target session to call register_session again.`,
          }
        }
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

      const requestId = randomUUID()
      try {
        await writeRequest({
          requestId,
          toSessionId: args.sessionId,
          question: args.question,
          createdAt: Date.now(),
        })
        const res = await pollForResponse(requestId, args.sessionId, {
          timeoutMs: budget,
          abort: ctx.abort,
        })
        if (res.error) {
          return {
            title: "target error",
            output: `ask_session error: target session reported an error: ${res.error}`,
          }
        }
        if (!res.reply) {
          return {
            title: "empty reply",
            output: `ask_session error: session ${args.sessionId} produced an empty reply.`,
          }
        }
        log.info("ask_session:ok", {
          sessionId: args.sessionId,
          replyChars: res.reply.length,
        })
        return res.reply
      } catch (err: unknown) {
        if (err instanceof AskTimeoutError) {
          return {
            title: "reply timeout",
            output:
              `ask_session error: session ${args.sessionId} did not respond within ${budget}ms. ` +
              `The target may be busy or its inbox watcher may not be running. ` +
              `Try again with a larger timeoutMs (max ${MAX_ASK_TIMEOUT_MS}).`,
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
        log.warn("ask_session:unknown-error", {
          sessionId: args.sessionId,
          error: errMsg,
        })
        return {
          title: "unexpected error",
          output: `ask_session error: unexpected error contacting session ${args.sessionId}: ${errMsg}`,
        }
      } finally {
        await cleanupRequest(requestId)
      }
    },
  })
}
