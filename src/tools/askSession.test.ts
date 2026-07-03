import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { upsertEntry } from "../registry.ts"
import { writeResponse, getMessagesDir } from "../fileTransport.ts"
import { createAskSessionTool } from "./askSession.ts"

function makeFakeCtx(
  overrides: { sessionID?: string; abort?: AbortSignal } = {},
): Parameters<ReturnType<typeof createAskSessionTool>["execute"]>[1] {
  return {
    sessionID: "ses_caller",
    messageID: "msg_1",
    agent: "test",
    directory: "/tmp/test",
    worktree: "/tmp/test",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...overrides,
  }
}

function asStructured(result: unknown): { title: string; output: string } {
  if (typeof result !== "object" || result === null) {
    throw new Error(`expected structured result, got: ${String(result)}`)
  }
  return result as { title: string; output: string }
}

let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-asksession-test-"))
  process.env.XDG_STATE_HOME = stateDir
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

async function seedTarget(
  sessionId: string,
  daemonId: string | undefined = "daemon-target",
): Promise<void> {
  await upsertEntry({
    sessionId,
    summary: "test target",
    directory: "/tmp/target",
    projectId: "p_target",
    serverUrl: "http://localhost:9999",
    daemonId,
  })
}

async function seedV1Target(sessionId: string): Promise<void> {
  await upsertEntry({
    sessionId,
    summary: "v1 target (no daemonId)",
    directory: "/tmp/target",
    projectId: "p_target",
  })
}

describe("ask_session tool (file-based IPC)", () => {
  test("happy path: request file written, response file appears → returns reply text", async () => {
    await seedTarget("ses_target")
    const t = createAskSessionTool()
    const promise = t.execute(
      { sessionId: "ses_target", question: "hello?", timeoutMs: 2000 },
      makeFakeCtx(),
    )
    // Simulate the inbox watcher writing a response file after a short delay.
    await new Promise((r) => setTimeout(r, 200))
    const { readdir } = await import("node:fs/promises")
    const files = await readdir(getMessagesDir())
    const reqFile = files.find((f) => f.endsWith(".req.json"))
    expect(reqFile).toBeDefined()
    const requestId = reqFile!.replace(".req.json", "")
    await writeResponse({
      requestId,
      reply: "4",
      createdAt: Date.now(),
    })
    const result = await promise
    expect(result).toBe("4")
  })

  test("self-ask forbidden → text error, no request file written", async () => {
    const t = createAskSessionTool()
    const result = await t.execute(
      { sessionId: "ses_caller", question: "should not fire" },
      makeFakeCtx({ sessionID: "ses_caller" }),
    )
    const { output } = asStructured(result)
    expect(output).toMatch(/cannot ask yourself/i)
  })

  test("not in registry → text error with list_sessions hint", async () => {
    const t = createAskSessionTool()
    const result = await t.execute(
      { sessionId: "ses_ghost", question: "hi there" },
      makeFakeCtx(),
    )
    const { output } = asStructured(result)
    expect(output).toMatch(/not in the registry/i)
    expect(output).toMatch(/list_sessions/)
  })

  test("v1 target (no daemonId) → text error advising re-register", async () => {
    await seedV1Target("ses_v1")
    const t = createAskSessionTool()
    const result = await t.execute(
      { sessionId: "ses_v1", question: "hi there" },
      makeFakeCtx(),
    )
    const { output } = asStructured(result)
    expect(output).toMatch(/older plugin version/i)
    expect(output).toMatch(/register_session again/i)
  })

  test("reply timeout: no response file appears → text error 'did not respond'", async () => {
    await seedTarget("ses_target")
    const t = createAskSessionTool()
    const result = await t.execute(
      { sessionId: "ses_target", question: "hi there", timeoutMs: 300 },
      makeFakeCtx(),
    )
    const { output } = asStructured(result)
    expect(output).toMatch(/did not respond/i)
  })

  test("response file has error field → text error 'target session reported'", async () => {
    await seedTarget("ses_target")
    const t = createAskSessionTool()
    const promise = t.execute(
      { sessionId: "ses_target", question: "hi there", timeoutMs: 2000 },
      makeFakeCtx(),
    )
    await new Promise((r) => setTimeout(r, 200))
    const { readdir } = await import("node:fs/promises")
    const files = await readdir(getMessagesDir())
    const reqFile = files.find((f) => f.endsWith(".req.json"))
    const requestId = reqFile!.replace(".req.json", "")
    await writeResponse({
      requestId,
      error: "LLM errored out on target side",
      createdAt: Date.now(),
    })
    const result = await promise
    const { output } = asStructured(result)
    expect(output).toMatch(/target session reported/i)
    expect(output).toMatch(/LLM errored out/i)
  })

  test("abort mid-wait → text error 'aborted', tool never throws", async () => {
    await seedTarget("ses_target")
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const t = createAskSessionTool()
    let result: unknown
    let threw = false
    try {
      result = await t.execute(
        { sessionId: "ses_target", question: "hi there", timeoutMs: 5000 },
        makeFakeCtx({ abort: ctrl.signal }),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    const { output } = asStructured(result)
    expect(output).toMatch(/aborted/i)
  })

  test("cleanup: request file is deleted after completion", async () => {
    await seedTarget("ses_target")
    const t = createAskSessionTool()
    const promise = t.execute(
      { sessionId: "ses_target", question: "hello?", timeoutMs: 2000 },
      makeFakeCtx(),
    )
    await new Promise((r) => setTimeout(r, 200))
    const { readdir } = await import("node:fs/promises")
    const files = await readdir(getMessagesDir())
    const reqFile = files.find((f) => f.endsWith(".req.json"))
    const requestId = reqFile!.replace(".req.json", "")
    await writeResponse({ requestId, reply: "ok", createdAt: Date.now() })
    await promise
    const afterFiles = await readdir(getMessagesDir())
    const leftover = afterFiles.filter(
      (f) => f.startsWith(requestId) && !f.endsWith(".tmp"),
    )
    expect(leftover).toHaveLength(0)
  })
})
