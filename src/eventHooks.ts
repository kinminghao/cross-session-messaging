import { log } from "./logger.ts"
import type { ITransport } from "./transport/interface.ts"

type EventInput = { event: { type?: string; properties?: unknown } }

export function createEventHandler(
  transport: ITransport,
): (input: EventInput) => Promise<void> {
  return async ({ event }) => {
    if (event.type !== "session.deleted") return
    const props = event.properties as { info?: { id?: unknown } } | undefined
    const sessionId = props?.info?.id
    if (typeof sessionId !== "string" || sessionId.length === 0) return
    try {
      const removed = await transport.remove(sessionId)
      log.info("event:session-deleted", { sessionId, removed })
    } catch (err: unknown) {
      log.warn("event:session-deleted-cleanup-fail", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
