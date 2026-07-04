import type { RegistryEntry } from "../types.ts"

export type InboxHandler = (
  sessionId: string,
  question: string,
  opts: { timeoutMs: number },
) => Promise<string>

export interface ITransport {
  register(
    entry: Omit<RegistryEntry, "registeredAt" | "updatedAt">,
  ): Promise<RegistryEntry>
  list(): Promise<RegistryEntry[]>
  remove(sessionId: string): Promise<boolean>
  lookup(sessionId: string): Promise<RegistryEntry | null>

  ask(params: {
    requestId: string
    toSessionId: string
    question: string
    timeoutMs: number
    abort?: AbortSignal
  }): Promise<{ reply?: string; error?: string }>

  startInbox(handler: InboxHandler): void
  stopInbox(): Promise<void>

  dispose(): Promise<void>
}
