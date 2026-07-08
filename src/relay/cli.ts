#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { RELAY_DEFAULT_PORT } from "../constants.ts"
import type { LogEvent } from "./core.ts"
import { RelayServer } from "./server.ts"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", short: "p", default: String(RELAY_DEFAULT_PORT) },
  },
})

const port = Number.parseInt(values.port ?? String(RELAY_DEFAULT_PORT), 10)
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error(`Invalid --port value: ${values.port}`)
  process.exit(1)
}

const server = new RelayServer({ port })

server.core.on("log", (evt: LogEvent) => {
  const ts = new Date().toISOString()
  console.log(`${ts} [${evt.level}] ${evt.tag}: ${evt.message}`)
})

server.start()

console.log(`Cross-session relay server listening on http://0.0.0.0:${port}`)
console.log(`Dashboard: http://localhost:${port}`)
console.log(`WebSocket: ws://localhost:${port}/ws`)

let stopping = false
function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  console.log(`\nReceived ${signal}, shutting down...`)
  server.stop()
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
