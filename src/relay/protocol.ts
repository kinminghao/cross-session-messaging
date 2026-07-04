import type { RegistryEntry } from "../types.ts"

export type ClientMessage =
  | {
      type: "register"
      sessionId: string
      summary: string
      directory: string
      projectId: string
      serverUrl?: string
      daemonId?: string
      deviceName?: string
    }
  | { type: "unregister"; sessionId: string }
  | { type: "list"; requestId: string }
  | { type: "lookup"; requestId: string; sessionId: string }
  | {
      type: "ask"
      requestId: string
      toSessionId: string
      question: string
      timeoutMs: number
    }
  | { type: "reply"; requestId: string; reply?: string; error?: string }

export type ServerMessage =
  | { type: "registered"; sessionId: string; entry: RegistryEntry }
  | { type: "unregistered"; sessionId: string; removed: boolean }
  | { type: "sessions"; requestId: string; entries: RegistryEntry[] }
  | { type: "looked-up"; requestId: string; entry: RegistryEntry | null }
  | {
      type: "inbound"
      requestId: string
      fromSessionId: string
      toSessionId: string
      question: string
      timeoutMs: number
    }
  | { type: "reply"; requestId: string; reply?: string; error?: string }
  | { type: "error"; requestId?: string; message: string }
