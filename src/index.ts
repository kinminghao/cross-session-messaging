import type { PluginModule } from "@opencode-ai/plugin"
import { PLUGIN_ID } from "./constants.ts"
import { createEventHandler } from "./eventHooks.ts"
import { initLogger, log } from "./logger.ts"
import { createAskSessionTool, type AskSessionClient } from "./tools/askSession.ts"
import { createListSessionsTool } from "./tools/listSessions.ts"
import { createRegisterSessionTool } from "./tools/registerSession.ts"

/**
 * Entry point for the `cross-session-messaging` opencode plugin.
 *
 * Wires the three tools (`register_session` / `list_sessions` /
 * `ask_session`) and installs the `session.deleted` event hook that
 * prunes the registry.
 *
 * Design doc: `../cross-session-messaging-design.md`
 * Executable plan: `../cross-session-messaging.md`
 */
const plugin: PluginModule = {
  id: PLUGIN_ID,
  server: async (input) => {
    initLogger(input.client)
    log.info("plugin:init", {
      projectId: input.project.id,
      directory: input.directory,
    })

    return {
      tool: {
        register_session: createRegisterSessionTool(input.project.id),
        list_sessions: createListSessionsTool(),
        // Cast: the real opencode SDK client is behaviorally compatible with
        // the duck-typed `AskSessionClient` (it has session.status /
        // promptAsync / messages / event.subscribe), but the SDK's generic
        // Options<T> signatures don't structurally match our minimal contract.
        // Safe at runtime — we only invoke the exact operations the duck-type
        // covers.
        ask_session: createAskSessionTool(
          input.client as unknown as AskSessionClient,
        ),
      },

      event: createEventHandler(),

      dispose: async () => {
        log.info("plugin:dispose")
      },
    }
  },
}

export default plugin
