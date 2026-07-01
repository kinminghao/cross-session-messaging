import { describe, expect, test } from "bun:test"
import { IdleWaitTimeoutError, SessionNotFoundError } from "./types.ts"
import { waitForIdle, type StatusClient } from "./waitForIdle.ts"

type FakeStatus = { type: string; [k: string]: unknown }

/**
 * Build a fake StatusClient that returns the scripted sequence, one item
 * per `session.status` call. After the script is exhausted, the LAST
 * item is returned indefinitely (or thrown, if it's an Error) — this is
 * how we simulate "always busy" without a huge array.
 */
function makeFakeClient(
  script: Array<FakeStatus | Error>,
): { calls: number; client: StatusClient } {
  const state = { calls: 0 }
  return {
    // Wrap `calls` so tests can read the increment count without needing
    // a live reference to the fake.
    get calls() {
      return state.calls
    },
    client: {
      session: {
        async status(_args) {
          const i = Math.min(state.calls, script.length - 1)
          state.calls++
          const item = script[i]
          if (item instanceof Error) throw item
          return item ?? { type: "idle" }
        },
      },
    },
  }
}

// Fast poll settings so busy-then-idle doesn't wait 250ms+ per cycle.
const fast = { initialDelayMs: 10, maxDelayMs: 40, backoffFactor: 2 } as const

describe("waitForIdle", () => {
  test("already-idle: resolves on first poll with no sleep", async () => {
    const fake = makeFakeClient([{ type: "idle" }])
    const start = Date.now()
    await waitForIdle(fake.client, "ses_a", { timeoutMs: 1000, ...fast })
    const elapsed = Date.now() - start
    // No sleep should happen — one status call, done.
    expect(elapsed).toBeLessThan(50)
    expect(fake.calls).toBe(1)
  })

  test("busy-then-idle: resolves after target flips to idle", async () => {
    const fake = makeFakeClient([{ type: "busy" }, { type: "busy" }, { type: "idle" }])
    await waitForIdle(fake.client, "ses_a", { timeoutMs: 1000, ...fast })
    expect(fake.calls).toBe(3)
  })

  test("never-idle: rejects with IdleWaitTimeoutError after timeoutMs", async () => {
    const fake = makeFakeClient([{ type: "busy" }])
    const start = Date.now()
    let caught: Error | undefined
    try {
      await waitForIdle(fake.client, "ses_a", { timeoutMs: 100, ...fast })
    } catch (err) {
      caught = err as Error
    }
    const elapsed = Date.now() - start
    expect(caught).toBeInstanceOf(IdleWaitTimeoutError)
    expect((caught as IdleWaitTimeoutError).sessionId).toBe("ses_a")
    expect((caught as IdleWaitTimeoutError).timeoutMs).toBe(100)
    // Should reject reasonably close to timeoutMs, not wildly overshoot.
    expect(elapsed).toBeLessThan(400)
  })

  test("abort mid-wait: rejects with AbortError within one poll cycle", async () => {
    const fake = makeFakeClient([{ type: "busy" }])
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 25)
    const start = Date.now()
    let caught: Error | undefined
    try {
      await waitForIdle(fake.client, "ses_a", {
        timeoutMs: 5000,
        abort: ctrl.signal,
        ...fast,
      })
    } catch (err) {
      caught = err as Error
    }
    const elapsed = Date.now() - start
    expect(caught?.name).toBe("AbortError")
    // Abort latency: should be well under 300ms per plan §T8 QA.
    expect(elapsed).toBeLessThan(300)
  })

  test("session-not-found: status call HTTP 404 → rejects with SessionNotFoundError", async () => {
    // Simulate an SDK-style error with `.status` on the error object.
    const notFound = Object.assign(new Error("Not Found"), { status: 404 })
    const fake = makeFakeClient([notFound])
    let caught: Error | undefined
    try {
      await waitForIdle(fake.client, "ses_missing", { timeoutMs: 1000, ...fast })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(SessionNotFoundError)
    expect((caught as SessionNotFoundError).sessionId).toBe("ses_missing")
  })

  test("session-not-found: nested response.status 404 also detected", async () => {
    // Alternate SDK error shape: `.response.status`.
    const nested = Object.assign(new Error("Not Found"), {
      response: { status: 404 },
    })
    const fake = makeFakeClient([nested])
    let caught: Error | undefined
    try {
      await waitForIdle(fake.client, "ses_missing", { timeoutMs: 1000, ...fast })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(SessionNotFoundError)
  })

  test("retry-status: treated the same as busy, keeps polling until idle", async () => {
    const fake = makeFakeClient([
      { type: "retry", nextAt: 12345 },
      { type: "retry", nextAt: 12346 },
      { type: "idle" },
    ])
    await waitForIdle(fake.client, "ses_a", { timeoutMs: 1000, ...fast })
    expect(fake.calls).toBe(3)
  })
})
