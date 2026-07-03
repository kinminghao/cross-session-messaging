import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AskClientMessage } from "../askAndWaitForReply.ts"
import { upsertEntry } from "../registry.ts"
import { createAskSessionTool, type AskSessionClient } from "./askSession.ts"

// ─── Fake SSE stream matching hey-api's ServerSentEventsResult ────────────

type FakeEvent = { type: string; properties?: { sessionID?: string } }

interface Waiter {
  resolve: (v: IteratorResult<FakeEvent>) => void
  reject: (err: unknown) => void
}

function makeFakeEventStream() {
  const queue: FakeEvent[] = []
  const waiters: Waiter[] = []
  let closed = false

  const stream = {
    async next(): Promise<IteratorResult<FakeEvent>> {
      const head = queue.shift()
      if (head !== undefined) return { value: head, done: false }
      if (closed) {
        return { value: undefined as unknown as FakeEvent, done: true }
      }
      return await new Promise((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
    },
    async return(_value?: unknown): Promise<IteratorResult<FakeEvent>> {
      closed = true
      while (waiters.length > 0) {
        const w = waiters.shift()
        w?.resolve({ value: undefined as unknown as FakeEvent, done: true })
      }
      return { value: undefined as unknown as FakeEvent, done: true }
    },
    [Symbol.asyncIterator]() {
      return stream
    },
  }

  return {
    subscribeResult: { stream },
    push(ev: FakeEvent): void {
      const w = waiters.shift()
      if (w) w.resolve({ value: ev, done: false })
      else queue.push(ev)
    },
  }
}

function makeFakeClient() {
  const eventStream = makeFakeEventStream()
  const promptCalls: Array<{ sessionId: string; text: string }> = []
  const messagesBySession: Record<string, AskClientMessage[]> = {}
  let promptError: unknown = null

  const client: AskSessionClient = {
    session: {
      async promptAsync(args) {
        if (promptError !== null) throw promptError
        promptCalls.push({
          sessionId: args.path.id,
          text: args.body.parts.map((p) => p.text).join(""),
        })
      },
      async messages(args) {
        return messagesBySession[args.path.id] ?? []
      },
    },
    event: {
      async subscribe() {
        return eventStream.subscribeResult
      },
    },
  }

  return {
    client,
    promptCalls,
    pushEvent: (ev: FakeEvent) => eventStream.push(ev),
    addMessage(sessionId: string, msg: AskClientMessage): void {
      const list = messagesBySession[sessionId] ?? []
      list.push(msg)
      messagesBySession[sessionId] = list
    },
    setPromptError(err: unknown): void {
      promptError = err
    },
  }
}

function makeFakeCtx(
  overrides: { sessionID?: string; abort?: AbortSignal } = {},
): Parameters<
  ReturnType<typeof createAskSessionTool>["execute"]
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

function assistantMsg(text: string, createdAt: number): AskClientMessage {
  return {
    info: { role: "assistant", time: { created: createdAt } },
    parts: [{ type: "text", text }],
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

const settle = (ms = 30): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

// ─── XDG isolation per test ───────────────────────────────────────────────

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

async function seedTarget(sessionId: string): Promise<void> {
  await upsertEntry({
    sessionId,
    summary: "test target session",
    directory: "/tmp/target",
    projectId: "p_target",
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ask_session tool", () => {
  test("happy path: registered target, idle event + assistant message → returns reply text as string", async () => {
    await seedTarget("ses_target")
    const fake = makeFakeClient()
    const t = createAskSessionTool(fake.client)
    const promise = t.execute(
      { sessionId: "ses_target", question: "hello?" },
      makeFakeCtx(),
    )
    await settle()
    fake.addMessage("ses_target", assistantMsg("hi from B", Date.now()))
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_target" },
    })
    const result = await promise
    expect(result).toBe("hi from B")
    expect(fake.promptCalls).toEqual([
      { sessionId: "ses_target", text: "hello?" },
    ])
  })

  test("self-ask forbidden: sessionId === ctx.sessionID → text error, no I/O", async () => {
    const fake = makeFakeClient()
    const t = createAskSessionTool(fake.client)
    const result = await t.execute(
      { sessionId: "ses_caller", question: "should not fire" },
      makeFakeCtx({ sessionID: "ses_caller" }),
    )
    const { output } = asStructured(result)
    expect(output).toMatch(/cannot ask yourself/i)
    expect(output).toMatch(/list_sessions/)
    expect(fake.promptCalls).toHaveLength(0)
  })

  test("not in registry: target absent → text error with list_sessions hint, no I/O", async () => {
    const fake = makeFakeClient()
    const t = createAskSessionTool(fake.client)
    const result = await t.execute(
      { sessionId: "ses_ghost", question: "hi there" },
      makeFakeCtx(),
    )
    const { output } = asStructured(result)
    expect(output).toMatch(/not in the registry/i)
    expect(output).toMatch(/list_sessions/)
    expect(fake.promptCalls).toHaveLength(0)
  })

  test("session-not-found via promptAsync 404 → text error mentioning deletion + list_sessions", async () => {
    await seedTarget("ses_target")
    const fake = makeFakeClient()
    fake.setPromptError(
      Object.assign(new Error("Not Found"), { status: 404 }),
    )
    const t = createAskSessionTool(fake.client)
    const result = await t.execute(
      { sessionId: "ses_target", question: "hi there" },
      makeFakeCtx(),
    )
    const { output } = asStructured(result)
    expect(output).toMatch(/does not exist/i)
    expect(output).toMatch(/list_sessions/)
  })

  test("reply timeout: no idle event within timeoutMs → text error 'did not respond'", async () => {
    await seedTarget("ses_target")
    const fake = makeFakeClient()
    const t = createAskSessionTool(fake.client)
    const result = await t.execute(
      { sessionId: "ses_target", question: "hi there", timeoutMs: 100 },
      makeFakeCtx(),
    )
    const { output } = asStructured(result)
    expect(output).toMatch(/did not respond/i)
  })

  test("no-response: idle arrives but assistant reply text is empty → text error 'empty reply'", async () => {
    await seedTarget("ses_target")
    const fake = makeFakeClient()
    const t = createAskSessionTool(fake.client)
    const promise = t.execute(
      { sessionId: "ses_target", question: "hi there", timeoutMs: 500 },
      makeFakeCtx(),
    )
    await settle()
    fake.addMessage("ses_target", {
      info: { role: "assistant", time: { created: Date.now() } },
      parts: [{ type: "text", text: "" }],
    })
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_target" },
    })
    const result = await promise
    const { output } = asStructured(result)
    expect(output).toMatch(/empty reply/i)
  })

  test("abort: caller aborts mid-wait → text error 'aborted', tool never throws", async () => {
    await seedTarget("ses_target")
    const fake = makeFakeClient()
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 30)
    const t = createAskSessionTool(fake.client)
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
})
