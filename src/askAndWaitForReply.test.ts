import { describe, expect, test } from "bun:test"
import {
  askAndWaitForReply,
  type AskClient,
  type AskClientMessage,
} from "./askAndWaitForReply.ts"
import {
  AskTimeoutError,
  NoResponseError,
  SessionNotFoundError,
} from "./types.ts"

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
  let returnCalled = false
  let streamError: Error | undefined

  const stream = {
    async next(): Promise<IteratorResult<FakeEvent>> {
      if (streamError) throw streamError
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
      returnCalled = true
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
    forceError(err: Error): void {
      streamError = err
      while (waiters.length > 0) {
        const w = waiters.shift()
        w?.reject(err)
      }
    },
    get returnCalled(): boolean {
      return returnCalled
    },
  }
}

function makeFakeClient() {
  const eventStream = makeFakeEventStream()
  const promptCalls: Array<{ sessionId: string; text: string }> = []
  const messagesBySession: Record<string, AskClientMessage[]> = {}
  let messagesError: unknown = null
  let promptError: unknown = null

  const client: AskClient = {
    session: {
      async promptAsync(args) {
        if (promptError !== null) throw promptError
        const text = args.body.parts.map((p) => p.text).join("")
        promptCalls.push({ sessionId: args.path.id, text })
      },
      async messages(args) {
        if (messagesError !== null) throw messagesError
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
    forceStreamError: (err: Error) => eventStream.forceError(err),
    get iteratorReturnCalled(): boolean {
      return eventStream.returnCalled
    },
    addMessage(sessionId: string, msg: AskClientMessage): void {
      const list = messagesBySession[sessionId] ?? []
      list.push(msg)
      messagesBySession[sessionId] = list
    },
    setMessagesError(err: unknown): void {
      messagesError = err
    },
    setPromptError(err: unknown): void {
      promptError = err
    },
  }
}

function assistantMsg(text: string, createdAt: number): AskClientMessage {
  return {
    info: { role: "assistant", time: { created: createdAt } },
    parts: [{ type: "text", text }],
  }
}

const settle = (ms = 30): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

// ─── Tests ────────────────────────────────────────────────────────────────

describe("askAndWaitForReply (event-driven, loop-wait)", () => {
  test("happy path: idle event + matching assistant message → returns text", async () => {
    const fake = makeFakeClient()
    const promise = askAndWaitForReply(fake.client, "ses_b", "hello?", {
      timeoutMs: 1000,
    })
    await settle()
    fake.addMessage("ses_b", assistantMsg("hi there", Date.now()))
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_b" },
    })
    const result = await promise
    expect(result).toBe("hi there")
    expect(fake.promptCalls).toEqual([{ sessionId: "ses_b", text: "hello?" }])
  })

  test("timeout: no idle event within timeoutMs → AskTimeoutError, cleanup fired", async () => {
    const fake = makeFakeClient()
    const start = Date.now()
    let caught: Error | undefined
    try {
      await askAndWaitForReply(fake.client, "ses_b", "hello", {
        timeoutMs: 80,
      })
    } catch (err) {
      caught = err as Error
    }
    const elapsed = Date.now() - start
    expect(caught).toBeInstanceOf(AskTimeoutError)
    expect(elapsed).toBeGreaterThanOrEqual(70)
    expect(elapsed).toBeLessThan(400)
    expect(fake.iteratorReturnCalled).toBe(true)
  })

  test("abort mid-wait: AbortError + iterator.return called", async () => {
    const fake = makeFakeClient()
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 30)
    let caught: Error | undefined
    try {
      await askAndWaitForReply(fake.client, "ses_b", "hello", {
        timeoutMs: 5000,
        abort: ctrl.signal,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.name).toBe("AbortError")
    expect(fake.iteratorReturnCalled).toBe(true)
  })

  test("non-target idle events are ignored; only target's idle triggers reply check", async () => {
    const fake = makeFakeClient()
    fake.addMessage("ses_other", assistantMsg("WRONG_ANSWER", Date.now()))
    const promise = askAndWaitForReply(fake.client, "ses_target", "hi", {
      timeoutMs: 2000,
    })
    await settle()
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_other" },
    })
    fake.pushEvent({ type: "message.updated" })
    await settle()
    fake.addMessage("ses_target", assistantMsg("correct", Date.now()))
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_target" },
    })
    const result = await promise
    expect(result).toBe("correct")
  })

  test("timestamp filter: old assistant message ignored, new one returned", async () => {
    const fake = makeFakeClient()
    fake.addMessage(
      "ses_target",
      assistantMsg("OLD_ANSWER_MUST_NOT_APPEAR", Date.now() - 5 * 60_000),
    )
    const promise = askAndWaitForReply(fake.client, "ses_target", "hi", {
      timeoutMs: 1000,
    })
    await settle()
    fake.addMessage("ses_target", assistantMsg("NEW_ANSWER", Date.now()))
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_target" },
    })
    const result = await promise
    expect(result).toBe("NEW_ANSWER")
  })

  test("loop-wait: target idle without matching message → keeps waiting until real reply arrives", async () => {
    const fake = makeFakeClient()
    const promise = askAndWaitForReply(fake.client, "ses_target", "hi", {
      timeoutMs: 2000,
    })
    await settle()
    // First idle for target — no reply yet (maybe a queued turn's idle).
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_target" },
    })
    await settle()
    // Second idle for target with the actual reply now.
    fake.addMessage("ses_target", assistantMsg("finally here", Date.now()))
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_target" },
    })
    const result = await promise
    expect(result).toBe("finally here")
  })

  test("assistant reply present but text is empty → NoResponseError", async () => {
    const fake = makeFakeClient()
    const promise = askAndWaitForReply(fake.client, "ses_target", "hi", {
      timeoutMs: 500,
    })
    await settle()
    fake.addMessage("ses_target", {
      info: { role: "assistant", time: { created: Date.now() } },
      parts: [{ type: "text", text: "" }],
    })
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_target" },
    })
    let caught: Error | undefined
    try {
      await promise
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(NoResponseError)
  })

  test("promptAsync 404 (target gone before send) → SessionNotFoundError + iterator cleaned up", async () => {
    const fake = makeFakeClient()
    fake.setPromptError(
      Object.assign(new Error("Not Found"), { status: 404 }),
    )
    let caught: Error | undefined
    try {
      await askAndWaitForReply(fake.client, "ses_target", "hi", {
        timeoutMs: 1000,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(SessionNotFoundError)
    expect(fake.iteratorReturnCalled).toBe(true)
  })

  test("messages 404 (session deleted mid-flight) → SessionNotFoundError + iterator cleaned up", async () => {
    const fake = makeFakeClient()
    const promise = askAndWaitForReply(fake.client, "ses_target", "hi", {
      timeoutMs: 1000,
    })
    await settle()
    fake.setMessagesError(
      Object.assign(new Error("Not Found"), { status: 404 }),
    )
    fake.pushEvent({
      type: "session.idle",
      properties: { sessionID: "ses_target" },
    })
    let caught: Error | undefined
    try {
      await promise
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(SessionNotFoundError)
    expect(fake.iteratorReturnCalled).toBe(true)
  })

  test("event stream error mid-wait → propagates cleanly + iterator cleanup called", async () => {
    const fake = makeFakeClient()
    const promise = askAndWaitForReply(fake.client, "ses_target", "hi", {
      timeoutMs: 5000,
    })
    await settle()
    const streamErr = new Error("stream disconnected")
    fake.forceStreamError(streamErr)
    let caught: Error | undefined
    try {
      await promise
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.message).toBe("stream disconnected")
    expect(fake.iteratorReturnCalled).toBe(true)
  })
})
