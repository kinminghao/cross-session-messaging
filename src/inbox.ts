import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { askAndWaitForReply, type AskClient } from "./askAndWaitForReply.ts"
import { INBOX_POLL_MS, INBOX_REQUEST_TIMEOUT_MS } from "./constants.ts"
import {
  getMessagesDir,
  readRequest,
  writeResponse,
  type FileRequest,
} from "./fileTransport.ts"
import { log } from "./logger.ts"
import { readRegistry } from "./registry.ts"

export type ProcessFn = (
  client: AskClient,
  sessionId: string,
  question: string,
  opts: { timeoutMs: number },
) => Promise<string>

export class InboxWatcher {
  private timer: ReturnType<typeof setInterval> | undefined
  private processing = new Set<string>()

  constructor(
    private client: AskClient,
    private daemonId: string,
    private processFn: ProcessFn = askAndWaitForReply,
    private pollMs: number = INBOX_POLL_MS,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.scan(), this.pollMs)
  }

  async dispose(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async scan(): Promise<void> {
    const dir = getMessagesDir()
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith(".req.json")) continue
      const requestId = file.replace(".req.json", "")
      if (this.processing.has(requestId)) continue
      if (files.includes(`${requestId}.res.json`)) continue

      const req = await readRequest(join(dir, file))
      if (!req?.toSessionId || !req.question) continue

      const reg = await readRegistry()
      const entry = reg.sessions[req.toSessionId]
      if (!entry?.daemonId || entry.daemonId !== this.daemonId) continue

      this.processing.add(requestId)
      void this.processRequest(req).finally(() =>
        this.processing.delete(requestId),
      )
    }
  }

  private async processRequest(req: FileRequest): Promise<void> {
    log.info("inbox:processing", {
      requestId: req.requestId,
      toSessionId: req.toSessionId,
    })
    try {
      const reply = await this.processFn(
        this.client,
        req.toSessionId,
        req.question,
        { timeoutMs: INBOX_REQUEST_TIMEOUT_MS },
      )
      await writeResponse({
        requestId: req.requestId,
        reply,
        createdAt: Date.now(),
      })
      log.info("inbox:responded", {
        requestId: req.requestId,
        replyChars: reply.length,
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.warn("inbox:process-error", {
        requestId: req.requestId,
        error: errMsg,
      })
      await writeResponse({
        requestId: req.requestId,
        error: errMsg,
        createdAt: Date.now(),
      })
    }
  }
}
