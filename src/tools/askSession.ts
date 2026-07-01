import { tool } from "@opencode-ai/plugin/tool"
import { askAndWaitForReply, type AskClient } from "../askAndWaitForReply.ts"
import {
  DEFAULT_ASK_TIMEOUT_MS,
  IDLE_WAIT_BUDGET_MS,
  MAX_ASK_TIMEOUT_MS,
} from "../constants.ts"
import { log } from "../logger.ts"
import { readRegistry } from "../registry.ts"
import {
  AskTimeoutError,
  IdleWaitTimeoutError,
  NoResponseError,
  SessionNotFoundError,
} from "../types.ts"
import { waitForIdle, type StatusClient } from "../waitForIdle.ts"

/**
 * The subset of opencode's SDK client that `ask_session` requires. In
 * production, the real SDK client (from `input.client`) structurally
 * satisfies both `StatusClient` (for `waitForIdle`) and `AskClient` (for
 * `askAndWaitForReply`), so this intersection is the minimum contract.
 */
export type AskSessionClient = StatusClient & AskClient

/**
 * `ask_session` — orchestrates §T7 registry pre-check + §T8 waitForIdle
 * + §T9 askAndWaitForReply into the user-facing tool. Corresponds to
 * executable plan §T13.
 *
 * NEVER throws. Every failure mode returns a text output that the calling
 * LLM can read and react to. See `renderError` for the taxonomy.
 */
export function createAskSessionTool(
  client: AskSessionClient,
): ReturnType<typeof tool> {
  return tool({
    description: [
      "Send a self-contained question to ANOTHER opencode session and wait for its AI-generated reply.",
      "The target session CANNOT see your conversation history — include ALL necessary context",
      "(background, code snippets, constraints) in the `question` text itself.",
      "If the target is busy, this tool waits (bounded) for it to become idle. On any failure,",
      "returns a clear error string. This tool NEVER throws.",
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
      // 1. Self-ask check — cheap, before any I/O.
      if (args.sessionId === ctx.sessionID) {
        return {
          title: "self-ask forbidden",
          output:
            `ask_session error: cannot ask yourself (sessionId ${args.sessionId} is this session). ` +
            `Use list_sessions to find a different target.`,
        }
      }

      // 2. Clamp / default the budget. Defense-in-depth: even if opencode
      //    doesn't enforce zod .max, our own clamp bounds the wait.
      const budget = Math.min(
        args.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
        MAX_ASK_TIMEOUT_MS,
      )

      // 3. Registry pre-check — produces a much better error than
      //    letting `waitForIdle` discover a stale session ID as a 404.
      try {
        const reg = await readRegistry()
        if (!(args.sessionId in reg.sessions)) {
          return {
            title: "not in registry",
            output:
              `ask_session error: session ${args.sessionId} is not in the registry. ` +
              `It may have exited or never registered. Call list_sessions to see current active sessions.`,
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

      const start = Date.now()
      try {
        // 4. Wait for the target to become idle. Consumes a portion of
        //    the total budget, capped at IDLE_WAIT_BUDGET_MS so a busy
        //    target doesn't burn the whole ask.
        const idleBudget = Math.min(IDLE_WAIT_BUDGET_MS, budget)
        await waitForIdle(client, args.sessionId, {
          timeoutMs: idleBudget,
          abort: ctx.abort,
        })

        // 5. Compute remaining budget for the send-and-wait phase.
        const remaining = budget - (Date.now() - start)
        if (remaining <= 0) {
          return {
            title: "budget exhausted",
            output:
              `ask_session error: exhausted total budget (${budget}ms) waiting for session ${args.sessionId} to become idle. ` +
              `Increase timeoutMs.`,
          }
        }

        // 6. Send + wait for the assistant reply.
        const reply = await askAndWaitForReply(
          client,
          args.sessionId,
          args.question,
          { timeoutMs: remaining, abort: ctx.abort },
        )
        log.info("ask_session:ok", {
          sessionId: args.sessionId,
          replyChars: reply.length,
        })
        // Happy path: return the reply directly as a bare string so the
        // calling LLM sees the target's answer with no framing noise.
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
        `ask_session error: session ${sessionId} was found in the registry but the opencode daemon reports it does not exist ` +
        `(may have been deleted mid-flight). The registry may be stale — call list_sessions again to refresh.`,
    }
  }
  if (err instanceof IdleWaitTimeoutError) {
    return {
      title: "idle-wait timeout",
      output:
        `ask_session error: session ${sessionId} did not become idle within ${err.timeoutMs}ms. ` +
        `It may be stuck in a long-running task. Try again later or increase timeoutMs.`,
    }
  }
  if (err instanceof AskTimeoutError) {
    return {
      title: "reply timeout",
      output:
        `ask_session error: session ${sessionId} did not respond within ${err.timeoutMs}ms. ` +
        `Try again with a larger timeoutMs (max ${MAX_ASK_TIMEOUT_MS}).`,
    }
  }
  if (err instanceof NoResponseError) {
    return {
      title: "no assistant reply",
      output:
        `ask_session error: session ${sessionId} went idle without producing an assistant reply. ` +
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
