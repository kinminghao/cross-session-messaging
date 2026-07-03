import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { upsertEntry } from "./registry.ts"
import { writeRequest, getMessagesDir } from "./fileTransport.ts"
import { InboxWatcher, type ProcessFn } from "./inbox.ts"

let stateDir: string
let originalXDG: string | undefined

beforeEach(() => {
  originalXDG = process.env.XDG_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), "xsm-inbox-test-"))
  process.env.XDG_STATE_HOME = stateDir
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalXDG
  rmSync(stateDir, { recursive: true, force: true })
})

const MY_DAEMON_ID = "daemon-mine"
const OTHER_DAEMON_ID = "daemon-other"

async function seedSession(
  sessionId: string,
  daemonId: string,
): Promise<void> {
  await upsertEntry({
    sessionId,
    summary: "test session",
    directory: "/tmp/test",
    projectId: "p_test",
    daemonId,
  })
}

function makeFakeProcessFn(): {
  processFn: ProcessFn
  calls: Array<{ sessionId: string; question: string }>
} {
  const calls: Array<{ sessionId: string; question: string }> = []
  return {
    calls,
    processFn: async (_client, sessionId, question) => {
      calls.push({ sessionId, question })
      return `reply to: ${question}`
    },
  }
}

// biome-ignore lint/suspicious/noExplicitAny: fake client for inbox watcher
const fakeClient: any = {}

describe("InboxWatcher", () => {
  test("picks up request for local session, writes response file", async () => {
    await seedSession("ses_local", MY_DAEMON_ID)
    const { processFn, calls } = makeFakeProcessFn()
    const watcher = new InboxWatcher(
      fakeClient,
      MY_DAEMON_ID,
      processFn,
      100,
    )
    await writeRequest({
      requestId: "req-1",
      toSessionId: "ses_local",
      question: "what is 2+2?",
      createdAt: Date.now(),
    })
    watcher.start()
    await new Promise((r) => setTimeout(r, 400))
    await watcher.dispose()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.question).toBe("what is 2+2?")
    const resPath = join(getMessagesDir(), "req-1.res.json")
    const res = JSON.parse(await readFile(resPath, "utf8"))
    expect(res.reply).toBe("reply to: what is 2+2?")
  })

  test("ignores request for session in different daemon", async () => {
    await seedSession("ses_remote", OTHER_DAEMON_ID)
    const { processFn, calls } = makeFakeProcessFn()
    const watcher = new InboxWatcher(
      fakeClient,
      MY_DAEMON_ID,
      processFn,
      100,
    )
    await writeRequest({
      requestId: "req-2",
      toSessionId: "ses_remote",
      question: "should not process",
      createdAt: Date.now(),
    })
    watcher.start()
    await new Promise((r) => setTimeout(r, 400))
    await watcher.dispose()

    expect(calls).toHaveLength(0)
    const files = await readdir(getMessagesDir())
    expect(files.filter((f) => f === "req-2.res.json")).toHaveLength(0)
  })

  test("ignores request that already has a response file", async () => {
    await seedSession("ses_local", MY_DAEMON_ID)
    const { processFn, calls } = makeFakeProcessFn()
    await writeRequest({
      requestId: "req-3",
      toSessionId: "ses_local",
      question: "already handled",
      createdAt: Date.now(),
    })
    const { writeResponse } = await import("./fileTransport.ts")
    await writeResponse({
      requestId: "req-3",
      reply: "old reply",
      createdAt: Date.now(),
    })
    const watcher = new InboxWatcher(
      fakeClient,
      MY_DAEMON_ID,
      processFn,
      100,
    )
    watcher.start()
    await new Promise((r) => setTimeout(r, 400))
    await watcher.dispose()

    expect(calls).toHaveLength(0)
  })

  test("processFn error → writes error response file", async () => {
    await seedSession("ses_local", MY_DAEMON_ID)
    const errorFn: ProcessFn = async () => {
      throw new Error("LLM exploded")
    }
    const watcher = new InboxWatcher(
      fakeClient,
      MY_DAEMON_ID,
      errorFn,
      100,
    )
    await writeRequest({
      requestId: "req-4",
      toSessionId: "ses_local",
      question: "trigger error",
      createdAt: Date.now(),
    })
    watcher.start()
    await new Promise((r) => setTimeout(r, 400))
    await watcher.dispose()

    const resPath = join(getMessagesDir(), "req-4.res.json")
    const res = JSON.parse(await readFile(resPath, "utf8"))
    expect(res.error).toBe("LLM exploded")
    expect(res.reply).toBeUndefined()
  })

  test("dispose stops the polling timer", async () => {
    const { processFn } = makeFakeProcessFn()
    const watcher = new InboxWatcher(
      fakeClient,
      MY_DAEMON_ID,
      processFn,
      50,
    )
    watcher.start()
    await watcher.dispose()
    // If timer is still running after dispose, this would eventually
    // process the request. Give it time to prove it doesn't.
    await seedSession("ses_local", MY_DAEMON_ID)
    await writeRequest({
      requestId: "req-5",
      toSessionId: "ses_local",
      question: "should not fire",
      createdAt: Date.now(),
    })
    await new Promise((r) => setTimeout(r, 200))
    const files = await readdir(getMessagesDir())
    expect(files.filter((f) => f === "req-5.res.json")).toHaveLength(0)
  })
})
