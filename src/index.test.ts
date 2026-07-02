import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import plugin from "./index.ts"

function makeFakeInput(): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {
      id: "test_project",
      worktree: "/tmp/wt",
      time: { created: 0 },
    },
    directory: "/tmp/dir",
    worktree: "/tmp/wt",
    serverUrl: new URL("http://localhost:1234"),
    experimental_workspace: { register: () => {} },
    $: (() => {}) as unknown as PluginInput["$"],
  } as unknown as PluginInput
}

describe("plugin default export", () => {
  test("plugin metadata: id is 'cross-session-messaging' and server is a function", () => {
    expect(plugin.id).toBe("cross-session-messaging")
    expect(typeof plugin.server).toBe("function")
  })

  test("server() wires all 3 tools + event + dispose hooks", async () => {
    const hooks = await plugin.server(makeFakeInput())
    expect(hooks.tool?.register_session).toBeDefined()
    expect(hooks.tool?.list_sessions).toBeDefined()
    expect(hooks.tool?.ask_session).toBeDefined()
    expect(typeof hooks.event).toBe("function")
    expect(typeof hooks.dispose).toBe("function")
  })

  test("event handler no-throw on unrelated event types", async () => {
    const hooks = await plugin.server(makeFakeInput())
    const handler = hooks.event
    expect(handler).toBeDefined()
    let threw = false
    try {
      // Fire an unrelated event — should be a silent no-op with zero registry I/O.
      // biome-ignore lint/suspicious/noExplicitAny: bypassing SDK's Event discriminated union for this smoke test.
      await handler!({ event: { type: "chat.message" } as any })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})
