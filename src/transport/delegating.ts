import type { RegistryEntry } from "../types.ts"
import type { ITransport, InboxHandler } from "./interface.ts"

export class DelegatingTransport implements ITransport {
  private _inner: ITransport
  private _inboxHandler: InboxHandler | null = null
  private _tracked = new Map<
    string,
    Omit<RegistryEntry, "registeredAt" | "updatedAt">
  >()

  constructor(initial: ITransport) {
    this._inner = initial
  }

  get inner(): ITransport {
    return this._inner
  }

  async switchTo(transport: ITransport): Promise<void> {
    await this._inner.stopInbox()
    await this._inner.dispose()
    this._inner = transport
    for (const entry of this._tracked.values()) {
      try {
        await transport.register(entry)
      } catch {
        /* noop */
      }
    }
    if (this._inboxHandler) {
      transport.startInbox(this._inboxHandler)
    }
  }

  async register(
    entry: Omit<RegistryEntry, "registeredAt" | "updatedAt">,
  ): Promise<RegistryEntry> {
    this._tracked.set(entry.sessionId, entry)
    return this._inner.register(entry)
  }

  async list(): Promise<RegistryEntry[]> {
    return this._inner.list()
  }

  async remove(sessionId: string): Promise<boolean> {
    this._tracked.delete(sessionId)
    return this._inner.remove(sessionId)
  }

  async lookup(sessionId: string): Promise<RegistryEntry | null> {
    return this._inner.lookup(sessionId)
  }

  async ask(params: {
    requestId: string
    toSessionId: string
    question: string
    timeoutMs: number
    abort?: AbortSignal
  }): Promise<{ reply?: string; error?: string }> {
    return this._inner.ask(params)
  }

  startInbox(handler: InboxHandler): void {
    this._inboxHandler = handler
    this._inner.startInbox(handler)
  }

  async stopInbox(): Promise<void> {
    await this._inner.stopInbox()
  }

  async dispose(): Promise<void> {
    this._inboxHandler = null
    await this._inner.dispose()
  }
}
