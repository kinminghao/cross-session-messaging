import { log } from "./logger.ts"
import { removeEntry } from "./registry.ts"

/**
 * Loose input type — this module doesn't depend on the SDK's `Event`
 * union so it can be unit-tested in isolation. The real
 * `EventSessionDeleted` (`{ type, properties: { info: Session } }`) is
 * a subtype and is accepted via TypeScript's parameter-contravariance.
 */
type EventInput = { event: { type?: string; properties?: unknown } }

/**
 * Build the opencode plugin `event` hook for `cross-session-messaging`.
 * Corresponds to executable plan §T14.
 *
 * Behavior: on `session.deleted`, prune the matching entry from the
 * shared registry. Every other event is a no-op. All errors from the
 * registry write are swallowed and logged — this handler MUST NEVER
 * throw, since a throw here would break opencode's event pipeline for
 * every other plugin.
 *
 * Divergence from executable plan §T14: the plan reads
 * `event.properties?.sessionID`, but the SDK's `EventSessionDeleted`
 * shape is `{ properties: { info: Session } }` with the ID at
 * `properties.info.id`. Following the plan verbatim would silently
 * no-op — `sessionID` would be `undefined` and `removeEntry` would
 * never run. We use `properties.info.id` here to actually prune.
 */
export function createEventHandler(): (input: EventInput) => Promise<void> {
  return async ({ event }) => {
    if (event.type !== "session.deleted") return
    const props = event.properties as { info?: { id?: unknown } } | undefined
    const sessionId = props?.info?.id
    if (typeof sessionId !== "string" || sessionId.length === 0) return
    try {
      const removed = await removeEntry(sessionId)
      log.info("event:session-deleted", { sessionId, removed })
    } catch (err: unknown) {
      log.warn("event:session-deleted-cleanup-fail", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
