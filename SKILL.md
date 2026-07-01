---
name: cross-session-messaging
description: Coordinate with other opencode sessions via the cross-session-messaging plugin. MUST USE when running as one of several parallel opencode sessions and you need to check facts with, delegate to, or get context from another session. Triggers - "ask session X", "check with the auth-refactor session", "who is working on Y", "coordinate with the other agent", "register my task", "advertise this session".
---

# Cross-Session Messaging

You have three tools from the `cross-session-messaging` plugin that let you
coordinate with other opencode sessions running in the same daemon.

## When to `register_session`

Call **once** at the start of a task, as soon as your goal is concrete
enough to describe. Update by calling again if the task shifts materially.

- GOOD summary: "refactoring OAuth token-refresh in `src/auth/oauth.ts`,
  keeping the existing `AuthProvider` interface stable"
- BAD summary: "writing code" / "helping the user" / "on it"

Other sessions read the summary to decide whether to ask you. Vague
summaries mean nobody finds you; over-detailed summaries make the
registry hard to skim.

## When to `list_sessions` + `ask_session`

Query the registry when you hit information you cannot derive from your
own context alone — module conventions you have not seen, historical
decisions, work in progress that overlaps yours.

1. `list_sessions()` → skim summaries.
2. Pick a target whose summary matches your need (skip if none match).
3. `ask_session(sessionId, question)` → wait for their reply.

Do **not** blast every session with the same question; pick one target
whose summary is the closest match.

## How to phrase the `question`

**The target session cannot see your conversation history.** Anything not
in the `question` string does not exist to them. Every question must be
self-contained.

- Include the background: what file/module/context you are in, what you
  are trying to achieve.
- Include code snippets inline — do not say "this function"; paste it.
- Ask a specific question, not a general one — "does approach X violate
  invariant Y you introduced in commit Z" beats "how should I do X".

Rule of thumb: if a new senior engineer picked up the question with zero
prior context, could they answer? If not, add more.

## Timeouts and failures

`ask_session` never throws. Every failure returns readable text:

- **Target session not found** → the ID is stale; re-run `list_sessions`.
- **Target stayed busy past the wait budget** → try again later, or pick
  a different session.
- **Reply timeout** → the target got the question but did not answer in
  time. Consider a longer `timeoutMs` (max 10 minutes) or a different
  target.
- **Abort** → the user cancelled you; propagate the cancellation.
- **Target deleted mid-flight** → the session was closed while you were
  waiting; pick a different target.

**Do not retry silently on timeout.** Surface the failure to the user
first — a session that answered slowly might be about to answer, and
double-asking wastes their compute.

## What you must not do

- Do not `ask_session` yourself as a self-check — you are already
  thinking, and it wastes a compute round.
- Do not chain deep `ask_session` graphs (A asks B asks C) without
  telling the user; latencies stack and double-timeout scenarios get
  hard to reason about.
- Do not treat `ask_session` replies as authoritative — the target is
  another AI, not a source of truth. Verify important claims against
  code.
