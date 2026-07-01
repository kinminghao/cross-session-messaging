import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { upsertEntry, writeRegistry } from "../registry.ts"
import { REGISTRY_SCHEMA_VERSION, type RegistryEntry } from "../types.ts"
import { createListSessionsTool } from "./listSessions.ts"

function makeFakeCtx(overrides: {
  sessionID?: string
} = {}): Parameters<
  ReturnType<typeof createListSessionsTool>["execute"]
>[1] {
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
    throw new Error(
      `expected structured { title, output } result, got: ${String(result)}`,
    )
  }
  return result as { title: string; output: string }
}

async function seedEntry(
  sessionId: string,
  summary: string,
  directory = "/tmp/dflt",
  projectId = "p_dflt",
): Promise<void> {
  await upsertEntry({ sessionId, summary, directory, projectId })
}

// ─── XDG isolation ──────────────────────────────────────────────────

let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-list-test-"))
  process.env.XDG_STATE_HOME = stateDir
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

// ─── Tests ──────────────────────────────────────────────────────────

describe("list_sessions tool", () => {
  test("empty registry returns exact 'No sessions registered.' message", async () => {
    const t = createListSessionsTool()
    const result = await t.execute({}, makeFakeCtx())
    const { output } = asStructured(result)
    expect(output).toBe("No sessions registered.")
  })

  test("excludes the calling session by default (includeSelf omitted)", async () => {
    await seedEntry("ses_a", "task A")
    await seedEntry("ses_b", "task B — this is caller")
    await seedEntry("ses_c", "task C")
    const t = createListSessionsTool()
    const result = await t.execute({}, makeFakeCtx({ sessionID: "ses_b" }))
    const { output } = asStructured(result)
    expect(output).toContain("ses_a")
    expect(output).not.toContain("ses_b")
    expect(output).toContain("ses_c")
  })

  test("includeSelf: true includes the calling session", async () => {
    await seedEntry("ses_a", "task A")
    await seedEntry("ses_b", "caller task")
    const t = createListSessionsTool()
    const result = await t.execute(
      { includeSelf: true },
      makeFakeCtx({ sessionID: "ses_b" }),
    )
    const { output } = asStructured(result)
    expect(output).toContain("ses_a")
    expect(output).toContain("ses_b")
  })

  test("stale entries (updatedAt > 24h ago) are filtered out", async () => {
    const now = Date.now()
    const stale: RegistryEntry = {
      sessionId: "ses_stale",
      summary: "way too old",
      directory: "/tmp",
      projectId: "p1",
      registeredAt: now - 25 * 3600 * 1000,
      updatedAt: now - 25 * 3600 * 1000,
    }
    const fresh: RegistryEntry = {
      sessionId: "ses_fresh",
      summary: "very recent",
      directory: "/tmp",
      projectId: "p1",
      registeredAt: now,
      updatedAt: now,
    }
    await writeRegistry({
      version: REGISTRY_SCHEMA_VERSION,
      sessions: { ses_stale: stale, ses_fresh: fresh },
    })
    const t = createListSessionsTool()
    const result = await t.execute(
      {},
      makeFakeCtx({ sessionID: "ses_caller" }),
    )
    const { output } = asStructured(result)
    expect(output).toContain("ses_fresh")
    expect(output).not.toContain("ses_stale")
  })

  test("output includes sessionId, summary, directory, and projectId per entry", async () => {
    await seedEntry(
      "ses_a",
      "auth refactor task",
      "/tmp/repo_x",
      "project_zulu",
    )
    const t = createListSessionsTool()
    const result = await t.execute(
      {},
      makeFakeCtx({ sessionID: "ses_caller" }),
    )
    const { output } = asStructured(result)
    expect(output).toContain("ses_a")
    expect(output).toContain("auth refactor task")
    expect(output).toContain("/tmp/repo_x")
    expect(output).toContain("project_zulu")
  })

  test("sorts entries by updatedAt descending (most recent first)", async () => {
    await seedEntry("ses_first", "first added")
    await new Promise((r) => setTimeout(r, 10))
    await seedEntry("ses_middle", "middle")
    await new Promise((r) => setTimeout(r, 10))
    await seedEntry("ses_last", "last added, most recent")
    const t = createListSessionsTool()
    const result = await t.execute(
      {},
      makeFakeCtx({ sessionID: "ses_caller" }),
    )
    const { output } = asStructured(result)
    const posLast = output.indexOf("ses_last")
    const posMiddle = output.indexOf("ses_middle")
    const posFirst = output.indexOf("ses_first")
    expect(posLast).toBeGreaterThan(-1)
    expect(posMiddle).toBeGreaterThan(-1)
    expect(posFirst).toBeGreaterThan(-1)
    // Most recent first → ses_last should come before ses_middle before ses_first
    expect(posLast).toBeLessThan(posMiddle)
    expect(posMiddle).toBeLessThan(posFirst)
  })
})
