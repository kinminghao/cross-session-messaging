# Cross-Session Messaging — Manual E2E Test Plan

Skeleton per executable plan §T6. Result fields are populated during
§T17 execution with PASS/FAIL + evidence path from live tmux runs against
two real opencode sessions.

> The "manual" label refers to running against **real live opencode
> daemons**, not to human tapping — an agent can execute every step via
> `interactive_bash` (tmux).

## How to run

Spin up two opencode sessions in separate tmux sessions:

```bash
# Terminal 1 (session A)
tmux new-session -d -s xsm-A 'cd /tmp/xsm-repoA && opencode'

# Terminal 2 (session B)
tmux new-session -d -s xsm-B 'cd /tmp/xsm-repoB && opencode'
```

Both repos need at least an empty git init. All 5 scenarios use this
setup; the cross-project scenario needs two different repo paths.

Evidence goes under `.sisyphus/evidence/task-17-scenarioN-<slug>.log`
(tmux capture of both panes).

---

## Scenario 1: Happy path (same project)

### Preconditions
- Registry file `~/.local/state/opencode/agents-registry.json` empty or absent.
- Session A and Session B both running in the same repo (`/tmp/xsm-happy`).

### Setup Commands
```bash
mkdir -p /tmp/xsm-happy && cd /tmp/xsm-happy && git init && git commit --allow-empty -m init
tmux new-session -d -s A 'cd /tmp/xsm-happy && opencode'
tmux new-session -d -s B 'cd /tmp/xsm-happy && opencode'
```

### Steps
1. In session A: call `register_session` with summary `"session A working on happy-path test"`.
2. In session B: call `register_session` with summary `"session B ready to answer"`.
3. In session A: call `list_sessions` — verify B appears with its summary.
4. In session A: call `ask_session sessionId=<B's id> question="What is 2+2? Answer with just the number, no other text."`.
5. Wait; A's tool should return with B's reply.

### Expected Outcome
A receives a reply string containing `"4"`; the tool call in A takes < 30s end-to-end for this trivial question.

### Evidence to Capture
- `.sisyphus/evidence/task-17-scenario1-happy.log` (tmux capture of both panes)

### Result (filled in during T17)
- PASS / FAIL: _pending_

---

## Scenario 2: Busy-target wait path

### Preconditions
- Both sessions running.
- B will be given a long-running task before A's ask arrives.

### Setup Commands
Same as Scenario 1.

### Steps
1. Both sessions registered.
2. In session B: send a long-running prompt (e.g. `"read /etc/passwd, count the lines, then write a 500-word explanation of the file format"`) — this occupies B's turn for 30–60s.
3. While B is still working, in session A: call `ask_session sessionId=<B> question="After you finish your current task, what is the capital of France? Reply with just the city name."`.
4. Time the interval from A's ask to A's reply.

### Expected Outcome
- A's tool call does NOT immediately error — it WAITS for B to finish its current turn.
- After B finishes and processes A's ask, A receives `"Paris"` (or an equivalent short reply).
- `time_from_A_ask_to_A_reply >= time_until_B_finishes_original_turn`.

### Evidence to Capture
- `.sisyphus/evidence/task-17-scenario2-busywait.log`

### Result (filled in during T17)
- PASS / FAIL: _pending_

---

## Scenario 3: Timeout path

### Preconditions
- Session A running.
- Session B either not responding (stuck in a very long task) or intentionally simulated as stuck.

### Setup Commands
Same base setup. To simulate a stuck B without a real 30-min task, use a small `timeoutMs` (e.g. `5000`).

### Steps
1. Both sessions registered.
2. Put B into an intentionally long-running task (e.g. an unbounded loop, or a slow shell command like `sleep 60`).
3. In session A: call `ask_session sessionId=<B> question="hello?" timeoutMs=5000`.
4. Verify A's tool returns an error string within ~5–6 seconds.

### Expected Outcome
A receives a text error containing `"did not respond within 5000ms"` (or `"did not become idle within"` if the busy-wait budget triggered first). No throw. No hang past ~6s.

### Evidence to Capture
- `.sisyphus/evidence/task-17-scenario3-timeout.log`

### Result (filled in during T17)
- PASS / FAIL: _pending_

---

## Scenario 4: Cross-project path

### Preconditions
- Two DIFFERENT git repos: `/tmp/xsm-repoA` and `/tmp/xsm-repoB`.
- A session running in each.

### Setup Commands
```bash
mkdir -p /tmp/xsm-repoA /tmp/xsm-repoB
git -C /tmp/xsm-repoA init && git -C /tmp/xsm-repoA commit --allow-empty -m init
git -C /tmp/xsm-repoB init && git -C /tmp/xsm-repoB commit --allow-empty -m init
tmux new-session -d -s A 'cd /tmp/xsm-repoA && opencode'
tmux new-session -d -s B 'cd /tmp/xsm-repoB && opencode'
```

### Steps
1. Both sessions call `register_session`.
2. In session A: call `list_sessions` — verify B is present with `directory: /tmp/xsm-repoB` and a `projectId` different from A's.
3. In session A: call `ask_session sessionId=<B> question="What is 2+2? Reply with just the number."`.
4. Wait for the reply.

### Expected Outcome
Cross-project ask works exactly like the same-project happy path. A's `list_sessions` shows both entries with distinct `directory` and `projectId`. A receives B's reply.

### Evidence to Capture
- `.sisyphus/evidence/task-17-scenario4-crossproject.log`

### Result (filled in during T17)
- PASS / FAIL: _pending_

---

## Scenario 5: Session-not-found path

### Preconditions
- At least session A running and registered.

### Steps
1. In session A: call `ask_session sessionId=ses_zzz_bogus_9999 question="hi"`.
2. Read the returned text.

### Expected Outcome
A receives a text error mentioning:
- The session is not in the registry (or was deleted).
- A hint to call `list_sessions` to refresh.

No throw. No hang.

### Evidence to Capture
- `.sisyphus/evidence/task-17-scenario5-notfound.log`

### Result (filled in during T17)
- PASS / FAIL: _pending_

---

## Bonus: `session.deleted` pruning smoke test

### Preconditions
- Scenario 1 or Scenario 4 executed successfully — B is registered.

### Steps
1. Kill session B (Ctrl-C the TUI, or `tmux kill-session -t B`).
2. Wait 2 seconds.
3. In session A: call `list_sessions`.

### Expected Outcome
Session B is NO LONGER in A's list output — the `session.deleted` hook pruned it. If B still shows, the 24h TTL is the fallback (not a failure of this scenario if the test is run fresh, but the hook itself did not fire).

### Evidence to Capture
- `.sisyphus/evidence/task-17-prune.log`

### Result (filled in during T17)
- PASS / FAIL: _pending_
