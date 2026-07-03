/**
 * AbortSignal utilities used by the ask_session pipeline to coordinate
 * cancellation and cleanup. Kept dependency-free for isolated unit-test.
 *
 * NOTE: `withAbortCleanup` is currently unused after the event-driven
 * refactor of askAndWaitForReply; kept exported since it's a
 * general-purpose helper that future modules may want.
 */

/** A synchronous or async cleanup callback registered with `withAbortCleanup`. */
export type CleanupFn = () => void | Promise<void>

/**
 * `setTimeout` wrapped in a Promise, cancellable by an AbortSignal.
 *
 * - Resolves after `ms` if the signal never fires.
 * - Rejects synchronously (before returning a pending promise wait) if
 *   `abort.aborted` was already true at call time.
 * - Rejects with `err.name === "AbortError"` if the signal fires during
 *   the wait. Timer and listener are cleaned up on ALL exit paths.
 */
export function abortableSleep(ms: number, abort?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (abort?.aborted) {
      reject(makeAbortError())
      return
    }
    // Forward-declared so onAbort can `clearTimeout` it.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      reject(makeAbortError())
    }
    timer = setTimeout(() => {
      abort?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    abort?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Run `fn`, collecting cleanups it registers via the `register` callback.
 * On any exit path (fn fulfilled, fn rejected, OR abort signal fired),
 * run all cleanups in **LIFO** order — best-effort, individual cleanup
 * errors are swallowed so they cannot mask fn's own outcome.
 *
 * Idempotent: even if abort fires while fn is still running, cleanups
 * run exactly ONCE — the `cleanupsRan` guard prevents double-execution
 * when the abort handler and the `finally` block both try to run them.
 *
 * Note: `fn` must observe the abort signal itself (e.g. via
 * `abortableSleep`) to short-circuit its work. This helper only manages
 * cleanup timing; it does not force `fn` to reject on abort.
 */
export async function withAbortCleanup<T>(
  fn: (register: (cleanup: CleanupFn) => void) => Promise<T>,
  abort?: AbortSignal,
): Promise<T> {
  const cleanups: CleanupFn[] = []
  const register = (cleanup: CleanupFn): void => {
    cleanups.push(cleanup)
  }
  let cleanupsRan = false
  const runCleanups = async (): Promise<void> => {
    if (cleanupsRan) return
    cleanupsRan = true
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        const cleanup = cleanups[i]
        if (cleanup) await cleanup()
      } catch {
        // Swallow — a cleanup failure must NEVER mask fn's own outcome.
      }
    }
  }
  const onAbort = (): void => {
    void runCleanups()
  }
  abort?.addEventListener("abort", onAbort, { once: true })
  try {
    if (abort?.aborted) throw makeAbortError()
    return await fn(register)
  } finally {
    abort?.removeEventListener("abort", onAbort)
    await runCleanups()
  }
}

function makeAbortError(): Error {
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}
