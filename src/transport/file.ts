import type { AskClient } from "../askAndWaitForReply.ts"
import {
  cleanupRequest,
  pollForResponse,
  writeRequest,
} from "../fileTransport.ts"
import { InboxWatcher, type ProcessFn } from "../inbox.ts"
import {
  listEntries,
  readRegistry,
  removeEntry,
  upsertEntry,
} from "../registry.ts"
import type { RegistryEntry } from "../types.ts"
import type { ITransport, InboxHandler } from "./interface.ts"

export class FileTransport implements ITransport {
  private watcher: InboxWatcher | null = null

  constructor(
    private client: AskClient,
    private daemonId: string,
  ) {}

  async register(
    entry: Omit<RegistryEntry, "registeredAt" | "updatedAt">,
  ): Promise<RegistryEntry> {
    return upsertEntry(entry)
  }

  async list(): Promise<RegistryEntry[]> {
    return listEntries()
  }

  async remove(sessionId: string): Promise<boolean> {
    return removeEntry(sessionId)
  }

  async lookup(sessionId: string): Promise<RegistryEntry | null> {
    const reg = await readRegistry()
    return reg.sessions[sessionId] ?? null
  }

  async ask(params: {
    requestId: string
    toSessionId: string
    question: string
    timeoutMs: number
    abort?: AbortSignal
  }): Promise<{ reply?: string; error?: string }> {
    try {
      await writeRequest({
        requestId: params.requestId,
        toSessionId: params.toSessionId,
        question: params.question,
        createdAt: Date.now(),
      })
      const res = await pollForResponse(
        params.requestId,
        params.toSessionId,
        { timeoutMs: params.timeoutMs, abort: params.abort },
      )
      return { reply: res.reply, error: res.error }
    } finally {
      await cleanupRequest(params.requestId)
    }
  }

  startInbox(handler: InboxHandler): void {
    const processFn: ProcessFn = (_client, sessionId, question, opts) =>
      handler(sessionId, question, opts)
    this.watcher = new InboxWatcher(this.client, this.daemonId, processFn)
    this.watcher.start()
  }

  async stopInbox(): Promise<void> {
    await this.watcher?.dispose()
    this.watcher = null
  }

  async dispose(): Promise<void> {
    await this.stopInbox()
  }
}
