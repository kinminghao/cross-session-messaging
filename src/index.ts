import type { PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { askAndWaitForReply, type AskClient } from "./askAndWaitForReply.ts"
import { getRelayUrl, writeRelayUrl } from "./config.ts"
import { PLUGIN_ID, SESSION_DISCOVERY_MS } from "./constants.ts"
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

    interface DiscoveredSession {
      id: string
      title: string
      projectID: string
      directory: string
    }

    const knownSessionIds = new Set<string>()
    const discoveryPoller = setInterval(async () => {
      try {
        const sessions = (await input.client.session.list({
          throwOnError: true,
          responseStyle: "data",
        })) as unknown as DiscoveredSession[]

        const currentIds = new Set<string>()
        for (const s of sessions) {
          currentIds.add(s.id)
          try {
            await transport.register({
              sessionId: s.id,
              summary: s.title || `Session ${s.id.slice(0, 8)}`,
              directory: s.directory || input.directory,
              projectId: s.projectID || input.project.id,
              serverUrl: input.serverUrl.toString(),
              daemonId,
              deviceName: device,
            })
          } catch {
            /* skip individual failures */
          }
        }

        for (const id of knownSessionIds) {
          if (!currentIds.has(id)) {
            try {
              await transport.remove(id)
            } catch {
              /* skip */
            }
          }
        }

        knownSessionIds.clear()
        for (const id of currentIds) knownSessionIds.add(id)
      } catch (err) {
        log.warn("discovery:fail", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }, SESSION_DISCOVERY_MS)

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
                "HTTP URL of the relay server (e.g. http://192.168.1.100:7351).",
              ),
          },
          async execute(args) {
            const url = args.url.trim()
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
              return {
                title: "invalid URL",
                output:
                  "connect_relay error: URL must start with http:// or https://",
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
        clearInterval(discoveryPoller)
        clearInterval(configPoller)
        await transport.dispose()
        log.info("plugin:dispose")
      },
    }
  },
}

export default plugin
