import type { PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { askAndWaitForReply, type AskClient } from "./askAndWaitForReply.ts"
import { getRelayUrl, writeRelayUrl } from "./config.ts"
import { PLUGIN_ID } from "./constants.ts"
import { createEventHandler } from "./eventHooks.ts"
import { initLogger, log } from "./logger.ts"
import { createAskSessionTool } from "./tools/askSession.ts"
import { createListSessionsTool } from "./tools/listSessions.ts"
import { createRegisterSessionTool } from "./tools/registerSession.ts"
import { DelegatingTransport } from "./transport/delegating.ts"
import { FileTransport } from "./transport/file.ts"
import type { ITransport } from "./transport/interface.ts"

const CONFIG_POLL_MS = 2_000

const plugin: PluginModule = {
  id: PLUGIN_ID,
  server: async (input) => {
    initLogger(input.client)
    const daemonId = randomUUID()
    const client = input.client as unknown as AskClient
    const relayUrl = getRelayUrl()
    const device = hostname()

    let inner: ITransport
    if (relayUrl) {
      const { RelayTransport } = await import("./transport/relay.ts")
      inner = new RelayTransport(relayUrl)
      log.info("plugin:init:relay", {
        projectId: input.project.id,
        directory: input.directory,
        daemonId,
        relayUrl,
        device,
      })
    } else {
      inner = new FileTransport(client, daemonId)
      log.info("plugin:init:file", {
        projectId: input.project.id,
        directory: input.directory,
        daemonId,
        device,
      })
    }

    const transport = new DelegatingTransport(inner)

    transport.startInbox((sessionId, question, opts) =>
      askAndWaitForReply(client, sessionId, question, opts),
    )

    let lastKnownUrl = relayUrl
    const configPoller = setInterval(() => {
      const currentUrl = getRelayUrl()
      if (currentUrl === lastKnownUrl) return
      lastKnownUrl = currentUrl
      if (currentUrl) {
        void import("./transport/relay.ts")
          .then(({ RelayTransport }) =>
            transport.switchTo(new RelayTransport(currentUrl)),
          )
          .then(() => log.info("config:relay-connected", { url: currentUrl }))
          .catch((err) =>
            log.warn("config:relay-connect-fail", {
              url: currentUrl,
              error: String(err),
            }),
          )
      }
    }, CONFIG_POLL_MS)

    return {
      tool: {
        register_session: createRegisterSessionTool(transport, {
          projectId: input.project.id,
          serverUrl: input.serverUrl.toString(),
          daemonId,
          deviceName: device,
        }),
        list_sessions: createListSessionsTool(transport, device),
        ask_session: createAskSessionTool(transport),
        connect_relay: tool({
          description:
            "Connect this daemon to a remote relay server for cross-device session messaging. " +
            "Takes effect immediately (no restart needed) and persists across restarts.",
          args: {
            url: tool.schema
              .string()
              .min(5)
              .describe(
                "WebSocket URL of the relay server (e.g. ws://192.168.1.100:7351).",
              ),
          },
          async execute(args) {
            const url = args.url.trim()
            if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
              return {
                title: "invalid URL",
                output:
                  "connect_relay error: URL must start with ws:// or wss://",
              }
            }
            try {
              const { RelayTransport } = await import("./transport/relay.ts")
              await transport.switchTo(new RelayTransport(url))
              await writeRelayUrl(url)
              lastKnownUrl = url
              log.info("connect_relay:ok", { url })
              return {
                title: "connected",
                output: `Connected to relay: ${url}`,
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              log.warn("connect_relay:fail", { url, error: msg })
              return {
                title: "connect failed",
                output: `connect_relay error: ${msg}`,
              }
            }
          },
        }),
      },

      event: createEventHandler(transport),

      dispose: async () => {
        clearInterval(configPoller)
        await transport.dispose()
        log.info("plugin:dispose")
      },
    }
  },
}

export default plugin
