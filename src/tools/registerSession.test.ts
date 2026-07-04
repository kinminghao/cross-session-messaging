import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRegistry } from "../registry.ts"
import { createRegisterSessionTool } from "./registerSession.ts"
import { FileTransport } from "../transport/file.ts"
import type { AskClient } from "../askAndWaitForReply.ts"

const fakeClient: AskClient = {
  session: {
    async promptAsync() {},
    async messages() { return [] },
  },
}

function makeFakeCtx(overrides: {
  sessionID?: string
  directory?: string
} = {}): Parameters<
  ReturnType<typeof createRegisterSessionTool>["execute"]
>[1] {
  return {
    sessionID: "ses_a",
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
let transport: FileTransport

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-register-test-"))
  process.env.XDG_STATE_HOME = stateDir
  transport = new FileTransport(fakeClient, "test-daemon")
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

describe("register_session tool", () => {
  test("fresh upsert: creates entry with all fields incl. daemonId", async () => {
    const t = createRegisterSessionTool(transport, {
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
      daemonId: "daemon-1",
      deviceName: "test-host",
    })
    await t.execute(
      { summary: "working on the auth module" },
      makeFakeCtx({ sessionID: "ses_a", directory: "/tmp/repo" }),
    )
    const reg = await readRegistry()
    const entry = reg.sessions.ses_a
    expect(entry).toBeDefined()
    expect(entry?.summary).toBe("working on the auth module")
    expect(entry?.directory).toBe("/tmp/repo")
    expect(entry?.projectId).toBe("p_test")
    expect(entry?.daemonId).toBe("daemon-1")
    expect(entry?.serverUrl).toBe("http://localhost:9999")
    expect(entry?.registeredAt).toBe(entry?.updatedAt)
  })

  test("re-upsert: preserves registeredAt, bumps updatedAt, updates daemonId on restart", async () => {
    const t1 = createRegisterSessionTool(transport, {
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
      daemonId: "daemon-old",
      deviceName: "test-host",
    })
    await t1.execute(
      { summary: "first task" },
      makeFakeCtx({ sessionID: "ses_a" }),
    )
    const before = (await readRegistry()).sessions.ses_a!
    await new Promise((r) => setTimeout(r, 10))
    const t2 = createRegisterSessionTool(transport, {
      projectId: "p_test",
      serverUrl: "http://localhost:8888",
      daemonId: "daemon-new",
      deviceName: "test-host",
    })
    await t2.execute(
      { summary: "updated task" },
      makeFakeCtx({ sessionID: "ses_a" }),
    )
    const after = (await readRegistry()).sessions.ses_a!
    expect(after.summary).toBe("updated task")
    expect(after.daemonId).toBe("daemon-new")
    expect(after.registeredAt).toBe(before.registeredAt)
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  test("whitespace-only summary: returns text error, does NOT throw", async () => {
    const t = createRegisterSessionTool(transport, {
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
      daemonId: "daemon-1",
      deviceName: "test-host",
    })
    let threw = false
    let result: unknown
    try {
      result = await t.execute({ summary: "     " }, makeFakeCtx())
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(asStructured(result).output).toMatch(/at least 5/i)
  })

  test("different session IDs produce separate entries", async () => {
    const t = createRegisterSessionTool(transport, {
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
      daemonId: "daemon-1",
      deviceName: "test-host",
    })
    await t.execute(
      { summary: "task 1 in session 1" },
      makeFakeCtx({ sessionID: "ses_1" }),
    )
    await t.execute(
      { summary: "task 2 in session 2" },
      makeFakeCtx({ sessionID: "ses_2" }),
    )
    const reg = await readRegistry()
    expect(Object.keys(reg.sessions)).toHaveLength(2)
  })

  test("directory from ctx is persisted", async () => {
    const t = createRegisterSessionTool(transport, {
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
      daemonId: "daemon-1",
      deviceName: "test-host",
    })
    await t.execute(
      { summary: "some task" },
      makeFakeCtx({ sessionID: "ses_a", directory: "/tmp/custom" }),
    )
    const reg = await readRegistry()
    expect(reg.sessions.ses_a?.directory).toBe("/tmp/custom")
  })
})
