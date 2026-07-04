import type { DelegatingTransport } from "./transport/delegating.ts"

const KEY = Symbol.for("cross-session-messaging:transport")
const store = globalThis as unknown as Record<symbol, DelegatingTransport | undefined>

export function setTransportInstance(t: DelegatingTransport): void {
  store[KEY] = t
}

export function getTransportInstance(): DelegatingTransport | null {
  return store[KEY] ?? null
}
