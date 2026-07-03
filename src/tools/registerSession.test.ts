import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRegistry } from "../registry.ts"
import { createRegisterSessionTool } from "./registerSession.ts"

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
    throw new Error(
      `expected structured { title, output } result, got: ${String(result)}`,
    )
  }
  return result as { title: string; output: string }
}

let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-register-test-"))
  process.env.XDG_STATE_HOME = stateDir
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

describe("register_session tool", () => {
  test("fresh upsert: creates entry with all fields incl. serverUrl", async () => {
    const t = createRegisterSessionTool({
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
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
    expect(entry?.serverUrl).toBe("http://localhost:9999")
    expect(entry?.registeredAt).toBe(entry?.updatedAt)
  })

  test("re-upsert: preserves registeredAt, bumps updatedAt, updates serverUrl", async () => {
    const t1 = createRegisterSessionTool({
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
    })
    await t1.execute(
      { summary: "first task" },
      makeFakeCtx({ sessionID: "ses_a", directory: "/tmp/repo" }),
    )
    const before = (await readRegistry()).sessions.ses_a!
    await new Promise((r) => setTimeout(r, 10))
    // Daemon restarted on a different port — serverUrl changes.
    const t2 = createRegisterSessionTool({
      projectId: "p_test",
      serverUrl: "http://localhost:8888",
    })
    await t2.execute(
      { summary: "updated task after pivot" },
      makeFakeCtx({ sessionID: "ses_a", directory: "/tmp/repo" }),
    )
    const after = (await readRegistry()).sessions.ses_a!
    expect(after.summary).toBe("updated task after pivot")
    expect(after.serverUrl).toBe("http://localhost:8888")
    expect(after.registeredAt).toBe(before.registeredAt)
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  test("whitespace-only summary: returns text error, does NOT throw", async () => {
    const t = createRegisterSessionTool({
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
    })
    let threw = false
    let result: unknown
    try {
      result = await t.execute(
        { summary: "     " },
        makeFakeCtx({ sessionID: "ses_a", directory: "/tmp/repo" }),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    const { output } = asStructured(result)
    expect(output).toMatch(/at least 5/i)
    const reg = await readRegistry()
    expect(reg.sessions.ses_a).toBeUndefined()
  })

  test("projectId + serverUrl captured from factory args, not ctx", async () => {
    const tA = createRegisterSessionTool({
      projectId: "project_A",
      serverUrl: "http://a-server:9999",
    })
    await tA.execute(
      { summary: "task in project A" },
      makeFakeCtx({ sessionID: "ses_1", directory: "/tmp/rA" }),
    )
    const tB = createRegisterSessionTool({
      projectId: "project_B",
      serverUrl: "http://b-server:8888",
    })
    await tB.execute(
      { summary: "task in project B" },
      makeFakeCtx({ sessionID: "ses_2", directory: "/tmp/rB" }),
    )
    const reg = await readRegistry()
    expect(reg.sessions.ses_1?.projectId).toBe("project_A")
    expect(reg.sessions.ses_1?.serverUrl).toBe("http://a-server:9999")
    expect(reg.sessions.ses_2?.projectId).toBe("project_B")
    expect(reg.sessions.ses_2?.serverUrl).toBe("http://b-server:8888")
  })

  test("different session IDs produce separate registry entries", async () => {
    const t = createRegisterSessionTool({
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
    })
    await t.execute(
      { summary: "task 1 in session 1" },
      makeFakeCtx({ sessionID: "ses_1", directory: "/tmp/r" }),
    )
    await t.execute(
      { summary: "task 2 in session 2" },
      makeFakeCtx({ sessionID: "ses_2", directory: "/tmp/r" }),
    )
    const reg = await readRegistry()
    expect(Object.keys(reg.sessions)).toHaveLength(2)
    expect(reg.sessions.ses_1?.summary).toBe("task 1 in session 1")
    expect(reg.sessions.ses_2?.summary).toBe("task 2 in session 2")
  })

  test("directory from ctx is persisted", async () => {
    const t = createRegisterSessionTool({
      projectId: "p_test",
      serverUrl: "http://localhost:9999",
    })
    await t.execute(
      { summary: "some task" },
      makeFakeCtx({ sessionID: "ses_a", directory: "/tmp/custom_dir_xyz" }),
    )
    const reg = await readRegistry()
    expect(reg.sessions.ses_a?.directory).toBe("/tmp/custom_dir_xyz")
  })

  test("success text includes sessionId, summary, directory, projectId, server URL", async () => {
    const t = createRegisterSessionTool({
      projectId: "my_project",
      serverUrl: "http://localhost:9999",
    })
    const result = await t.execute(
      { summary: "auth refactor task" },
      makeFakeCtx({ sessionID: "ses_a", directory: "/tmp/repo" }),
    )
    const { output } = asStructured(result)
    expect(output).toContain("ses_a")
    expect(output).toContain("auth refactor task")
    expect(output).toContain("/tmp/repo")
    expect(output).toContain("my_project")
    expect(output).toContain("http://localhost:9999")
  })
})
