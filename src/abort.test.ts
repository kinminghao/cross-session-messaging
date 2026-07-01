import { describe, expect, test } from "bun:test"
import { abortableSleep, withAbortCleanup } from "./abort.ts"

describe("abortableSleep", () => {
  test("resolves after the specified ms when no signal is provided", async () => {
    const start = Date.now()
    await abortableSleep(100)
    const elapsed = Date.now() - start
    // Small tolerance for timer inaccuracy; upper bound guards against hangs.
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(300)
  })

  test("rejects with AbortError when signal aborts mid-sleep, within one poll cycle", async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const start = Date.now()
    let caught: Error | undefined
    try {
      await abortableSleep(1000, ctrl.signal)
    } catch (err) {
      caught = err as Error
    }
    const elapsed = Date.now() - start
    expect(caught?.name).toBe("AbortError")
    // Should reject shortly after the 50ms abort, not wait the full 1000ms.
    expect(elapsed).toBeLessThan(200)
  })

  test("rejects (near-)synchronously when signal is already aborted", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const start = Date.now()
    let caught: Error | undefined
    try {
      await abortableSleep(1000, ctrl.signal)
    } catch (err) {
      caught = err as Error
    }
    const elapsed = Date.now() - start
    expect(caught?.name).toBe("AbortError")
    // Rejection must not schedule the timer at all.
    expect(elapsed).toBeLessThan(50)
  })
})

describe("withAbortCleanup", () => {
  test("fn completes normally → cleanups run in LIFO (reverse-registration) order", async () => {
    const calls: string[] = []
    const result = await withAbortCleanup(async (register) => {
      register(() => {
        calls.push("A")
      })
      register(() => {
        calls.push("B")
      })
      register(() => {
        calls.push("C")
      })
      return "ok"
    })
    expect(result).toBe("ok")
    expect(calls).toEqual(["C", "B", "A"])
  })

  test("abort fires mid-fn → cleanups run + wrapped call rejects with AbortError", async () => {
    const ctrl = new AbortController()
    const calls: string[] = []
    setTimeout(() => ctrl.abort(), 30)
    let caught: Error | undefined
    try {
      await withAbortCleanup(async (register) => {
        register(() => {
          calls.push("cleanup")
        })
        // fn observes the abort via abortableSleep — this is required
        // for the wrapped call to actually reject on abort.
        await abortableSleep(500, ctrl.signal)
        return "unreachable"
      }, ctrl.signal)
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.name).toBe("AbortError")
    expect(calls).toEqual(["cleanup"])
  })

  test("fn throws non-abort error → cleanups run in LIFO + original error propagates", async () => {
    const calls: string[] = []
    let caught: Error | undefined
    try {
      await withAbortCleanup(async (register) => {
        register(() => {
          calls.push("A")
        })
        register(() => {
          calls.push("B")
        })
        throw new Error("boom")
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.message).toBe("boom")
    expect(calls).toEqual(["B", "A"])
  })
})
