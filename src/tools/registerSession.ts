import { tool } from "@opencode-ai/plugin/tool"
import { upsertEntry } from "../registry.ts"
import { log } from "../logger.ts"

export function createRegisterSessionTool(input: {
  projectId: string
  serverUrl: string
  daemonId: string
}): ReturnType<typeof tool> {
  return tool({
    description: [
      "Advertise THIS session's current task in the shared cross-session registry",
      "so other sessions can find you by natural-language summary and, via `ask_session`,",
      "send you a question. Call once when your task is well-defined; call again to update.",
    ].join(" "),
    args: {
      summary: tool.schema
        .string()
        .min(5)
        .max(2000)
        .describe(
          "Natural-language summary of what THIS session is currently working on. " +
            "Be specific (e.g. 'refactoring token refresh in src/auth/oauth.ts' beats 'writing code'). " +
            "Other sessions read this to decide whether to ask you.",
        ),
    },
    async execute(args, ctx) {
      const summary = args.summary.trim()
      if (summary.length < 5) {
        return {
          title: "register failed",
          output: `register_session error: summary must be at least 5 non-whitespace chars (got ${summary.length}).`,
        }
      }
      try {
        const entry = await upsertEntry({
          sessionId: ctx.sessionID,
          summary,
          directory: ctx.directory,
          projectId: input.projectId,
          serverUrl: input.serverUrl,
          daemonId: input.daemonId,
        })
        log.info("register_session:ok", {
          sessionId: ctx.sessionID,
          summaryChars: summary.length,
        })
        return {
          title: "registered",
          output:
            `Registered session ${ctx.sessionID}.\n` +
            `Summary: ${summary}\n` +
            `Directory: ${ctx.directory}\n` +
            `Project: ${input.projectId}\n` +
            `Updated: ${new Date(entry.updatedAt).toISOString()}`,
        }
      } catch (error) {
        log.warn("register_session:fail", { error: String(error) })
        return {
          title: "register failed",
          output: `register_session failed: ${String(error)}`,
        }
      }
    },
  })
}
