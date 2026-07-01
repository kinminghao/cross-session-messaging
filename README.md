# cross-session-messaging

An [OpenCode](https://opencode.ai) **plugin** that lets multiple sessions in
the same daemon talk to each other: any session can register a task summary,
discover other active sessions, and send a self-contained question to one of
them — waiting for the AI-generated reply.

> **Status**: scaffold only. Tool signatures, config, registry skeleton, and
> `session.deleted` cleanup hook are in place; the core `ask_session` algorithm
> is not implemented. See the design doc and executable plan below for the TDD
> sequence that fills in behavior.

## Why

Multi-agent setups need cross-session context, but opencode has no built-in
"session A asks session B" primitive. This plugin adds one, working
**in-process** so long tool calls do not get killed by MCP HTTP timeouts (an
external MCP server cannot do this — see design doc §1.2).

## Tools

| Tool | Purpose |
|------|---------|
| `register_session(summary)` | Advertise this session's current task in the shared registry. |
| `list_sessions(includeSelf?)` | Read the registry to pick a target for `ask_session`. |
| `ask_session(sessionId, question, timeoutMs?)` | Send a question to another session and wait for the AI-generated reply. Never throws — all six failure modes return readable text. |

## Storage

Registry file: `~/.local/state/opencode/agents-registry.json` (or
`$XDG_STATE_HOME/opencode/agents-registry.json`). Global — sessions in
different git repos can find each other because the file is per-user, not
per-project.

Written atomically (temp + rename) with an in-process mutex; each entry has
a 24h stale-TTL as defense-in-depth for missed `session.deleted` events.

## Install (once implemented)

Register in `~/.config/opencode/opencode.json` — **not** `tui.json`, this is
a regular plugin, not a TUI plugin:

```json
{
  "$schema": "https://opencode.ai/opencode.json",
  "plugin": ["cross-session-messaging"]
}
```

For local development, point at the absolute path of `src/index.ts`:

```json
{
  "$schema": "https://opencode.ai/opencode.json",
  "plugin": ["/absolute/path/to/cross-session-messaging/src/index.ts"]
}
```

## Development

```bash
bun install
bun run typecheck
bun test
```

## Layout

```
src/
├── index.ts                # entry (PluginModule default export)
├── constants.ts            # PLUGIN_ID, timeouts, backoff, TTL
├── xdg.ts                  # XDG_STATE_HOME resolver + getRegistryPath()
├── types.ts                # RegistryEntry / Registry / arg interfaces / 4 Error subclasses
├── logger.ts               # PLUGIN_ID-tagged log helper
├── registry.ts             # atomic file I/O + in-process mutex (scaffold)
└── tools/
    ├── registerSession.ts  # tool: register_session
    ├── listSessions.ts     # tool: list_sessions
    └── askSession.ts       # tool: ask_session (stub with algorithm as comments)
SKILL.md                    # LLM-facing usage guide (skill definition)
test/manual/
└── MANUAL_TEST_PLAN.md     # 5 E2E scenarios (skeleton, filled in during T17)
```

## See also

- Design doc: [`cross-session-messaging-design.md`](../cross-session-messaging-design.md)
- Executable plan: [`cross-session-messaging.md`](../cross-session-messaging.md)
  (Momus-approved, 17 implementation tasks + 4 verification tasks, TDD)
- Accompanying skill: [`SKILL.md`](./SKILL.md)

## License

MIT
