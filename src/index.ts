import type { PluginModule } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { AskClient } from "./askAndWaitForReply.ts"
import { PLUGIN_ID } from "./constants.ts"
import { createEventHandler } from "./eventHooks.ts"
import { initLogger, log } from "./logger.ts"
import { createAskSessionTool } from "./tools/askSession.ts"
import { createListSessionsTool } from "./tools/listSessions.ts"
import { createRegisterSessionTool } from "./tools/registerSession.ts"

const plugin: PluginModule = {
  id: PLUGIN_ID,
  server: async (input) => {
    initLogger(input.client)
    log.info("plugin:init", {
      projectId: input.project.id,
      directory: input.directory,
      serverUrl: input.serverUrl.toString(),
    })

    return {
      tool: {
        register_session: createRegisterSessionTool({
          projectId: input.project.id,
          serverUrl: input.serverUrl.toString(),
        }),
        list_sessions: createListSessionsTool(),
        // The factory constructs an OpencodeClient aimed at the TARGET
        // session's daemon (URL read from the registry). The SDK's generic
        // Options<T> signatures don't structurally match our minimal
        // AskClient duck-type, so we cast at this boundary — safe at
        // runtime because we only invoke the operations AskClient covers.
        ask_session: createAskSessionTool(
          (url) =>
            createOpencodeClient({ baseUrl: url }) as unknown as AskClient,
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
