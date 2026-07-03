import type { PluginModule } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import type { AskClient } from "./askAndWaitForReply.ts"
import { PLUGIN_ID } from "./constants.ts"
import { createEventHandler } from "./eventHooks.ts"
import { InboxWatcher } from "./inbox.ts"
import { initLogger, log } from "./logger.ts"
import { createAskSessionTool } from "./tools/askSession.ts"
import { createListSessionsTool } from "./tools/listSessions.ts"
import { createRegisterSessionTool } from "./tools/registerSession.ts"

const plugin: PluginModule = {
  id: PLUGIN_ID,
  server: async (input) => {
    initLogger(input.client)
    const daemonId = randomUUID()
    log.info("plugin:init", {
      projectId: input.project.id,
      directory: input.directory,
      daemonId,
    })

    const watcher = new InboxWatcher(
      input.client as unknown as AskClient,
      daemonId,
    )
    watcher.start()

    return {
      tool: {
        register_session: createRegisterSessionTool({
          projectId: input.project.id,
          serverUrl: input.serverUrl.toString(),
          daemonId,
        }),
        list_sessions: createListSessionsTool(),
        ask_session: createAskSessionTool(),
      },

      event: createEventHandler(),

      dispose: async () => {
        await watcher.dispose()
        log.info("plugin:dispose")
      },
    }
  },
}

export default plugin
