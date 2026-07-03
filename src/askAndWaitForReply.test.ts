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

function assistantMsg(text: string, createdAt: number): AskClientMessage {
  return {
    info: { role: "assistant", time: { created: createdAt } },
    parts: [{ type: "text", text }],
  }
}

function makeFakeClient() {
  const promptCalls: Array<{ sessionId: string; text: string }> = []
  const messagesBySession: Record<string, AskClientMessage[]> = {}
  let promptError: unknown = null
  let messagesError: unknown = null

  const client: AskClient = {
    session: {
      async promptAsync(args) {
        if (promptError !== null) throw promptError
        promptCalls.push({
          sessionId: args.path.id,
          text: args.body.parts.map((p) => p.text).join(""),
        })
      },
      async messages(args) {
        if (messagesError !== null) throw messagesError
        return messagesBySession[args.path.id] ?? []
      },
    },
  }

  return {
    client,
    promptCalls,
    addMessage(sessionId: string, msg: AskClientMessage): void {
      const list = messagesBySession[sessionId] ?? []
      list.push(msg)
      messagesBySession[sessionId] = list
    },
    setPromptError(err: unknown): void {
      promptError = err
    },
    setMessagesError(err: unknown): void {
      messagesError = err
    },
  }
}

describe("askAndWaitForReply (polling-based)", () => {
  test("happy path: assistant message appears after prompt → returns text", async () => {
    const fake = makeFakeClient()
    setTimeout(() => {
      fake.addMessage("ses_b", assistantMsg("hi there", Date.now()))
    }, 300)
    const result = await askAndWaitForReply(fake.client, "ses_b", "hello?", {
      timeoutMs: 5000,
    })
    expect(result).toBe("hi there")
    expect(fake.promptCalls).toEqual([{ sessionId: "ses_b", text: "hello?" }])
  })

  test("timeout: no assistant message within timeoutMs → AskTimeoutError", async () => {
    const fake = makeFakeClient()
    let caught: Error | undefined
    try {
      await askAndWaitForReply(fake.client, "ses_b", "hello", {
        timeoutMs: 600,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(AskTimeoutError)
  })

  test("abort mid-wait → AbortError", async () => {
    const fake = makeFakeClient()
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 100)
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
  })

  test("timestamp filter: old assistant message ignored, new one returned", async () => {
    const fake = makeFakeClient()
    fake.addMessage(
      "ses_b",
      assistantMsg("OLD_MUST_NOT_APPEAR", Date.now() - 5 * 60_000),
    )
    setTimeout(() => {
      fake.addMessage("ses_b", assistantMsg("NEW_ANSWER", Date.now()))
    }, 300)
    const result = await askAndWaitForReply(fake.client, "ses_b", "hi", {
      timeoutMs: 5000,
    })
    expect(result).toBe("NEW_ANSWER")
  })

  test("promptAsync 404 → SessionNotFoundError", async () => {
    const fake = makeFakeClient()
    fake.setPromptError(
      Object.assign(new Error("Not Found"), { status: 404 }),
    )
    let caught: Error | undefined
    try {
      await askAndWaitForReply(fake.client, "ses_b", "hi", {
        timeoutMs: 1000,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(SessionNotFoundError)
  })

  test("messages 404 mid-poll → SessionNotFoundError", async () => {
    const fake = makeFakeClient()
    setTimeout(() => {
      fake.setMessagesError(
        Object.assign(new Error("Not Found"), { status: 404 }),
      )
    }, 300)
    let caught: Error | undefined
    try {
      await askAndWaitForReply(fake.client, "ses_b", "hi", {
        timeoutMs: 5000,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(SessionNotFoundError)
  })

  test("empty text parts are skipped, waits for non-empty", async () => {
    const fake = makeFakeClient()
    setTimeout(() => {
      fake.addMessage("ses_b", {
        info: { role: "assistant", time: { created: Date.now() } },
        parts: [{ type: "text", text: "" }],
      })
    }, 200)
    setTimeout(() => {
      fake.addMessage("ses_b", assistantMsg("real answer", Date.now()))
    }, 600)
    const result = await askAndWaitForReply(fake.client, "ses_b", "hi", {
      timeoutMs: 5000,
    })
    expect(result).toBe("real answer")
  })
})
