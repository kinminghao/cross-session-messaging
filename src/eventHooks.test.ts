import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEventHandler } from "./eventHooks.ts"
import { readRegistry, upsertEntry } from "./registry.ts"
import { FileTransport } from "./transport/file.ts"
import type { AskClient } from "./askAndWaitForReply.ts"

const fakeClient: AskClient = {
  session: {
    async promptAsync() {},
    async messages() { return [] },
  },
}

let stateDir: string
let originalXDG: string | undefined
let transport: FileTransport

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-events-test-"))
  process.env.XDG_STATE_HOME = stateDir
  transport = new FileTransport(fakeClient, "test-daemon")
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

async function seed(sessionId: string): Promise<void> {
  await upsertEntry({
    sessionId,
    summary: "seeded target",
    directory: "/tmp/seed",
    projectId: "p_seed",
  })
}

describe("createEventHandler", () => {
  test("session.deleted event prunes the matching registry entry", async () => {
    await seed("ses_a")
    await seed("ses_b")
    await seed("ses_c")
    const handler = createEventHandler(transport)
    await handler({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_b" } },
      },
    })
    const reg = await readRegistry()
    expect(reg.sessions.ses_a).toBeDefined()
    expect(reg.sessions.ses_b).toBeUndefined()
    expect(reg.sessions.ses_c).toBeDefined()
  })

  test("unrelated event types do not touch the registry", async () => {
    await seed("ses_a")
    const handler = createEventHandler(transport)
    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "ses_a" },
      },
    })
    await handler({
      event: { type: "message.updated", properties: {} },
    })
    const reg = await readRegistry()
    expect(reg.sessions.ses_a).toBeDefined()
  })

  test("session.deleted for an absent session is a silent no-op", async () => {
    const handler = createEventHandler(transport)
    let threw = false
    try {
      await handler({
        event: {
          type: "session.deleted",
          properties: { info: { id: "ses_ghost" } },
        },
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    const reg = await readRegistry()
    expect(Object.keys(reg.sessions)).toHaveLength(0)
  })

  test("malformed session.deleted events (missing/empty id) never throw and never prune", async () => {
    await seed("ses_a")
    const handler = createEventHandler(transport)
    let threw = false
    try {
      await handler({ event: { type: "session.deleted" } })
      await handler({ event: { type: "session.deleted", properties: {} } })
      await handler({
        event: { type: "session.deleted", properties: { info: {} } },
      })
      await handler({
        event: {
          type: "session.deleted",
          properties: { info: { id: "" } },
        },
      })
      await handler({
        event: {
          type: "session.deleted",
          properties: { info: { id: null } },
        },
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    // The originally seeded entry must survive all malformed events.
    const reg = await readRegistry()
    expect(reg.sessions.ses_a).toBeDefined()
  })

  test("concurrent session.deleted for 3 IDs: all pruned, file remains valid", async () => {
    await seed("ses_a")
    await seed("ses_b")
    await seed("ses_c")
    const handler = createEventHandler(transport)
    await Promise.all([
      handler({
        event: {
          type: "session.deleted",
          properties: { info: { id: "ses_a" } },
        },
      }),
      handler({
        event: {
          type: "session.deleted",
          properties: { info: { id: "ses_b" } },
        },
      }),
      handler({
        event: {
          type: "session.deleted",
          properties: { info: { id: "ses_c" } },
        },
      }),
    ])
    const reg = await readRegistry()
    expect(Object.keys(reg.sessions)).toHaveLength(0)
  })
})
