# 跨会话消息传递 — 手动端到端测试计划

按可执行计划 §T6 编写的框架。结果字段在 §T17 执行阶段填入 PASS/FAIL + 来自真实 tmux 运行的证据路径（两个真实 opencode session）。

> 这里的"手动"指的是在**真实的 opencode daemon** 上运行，而非人工点击——agent 可以通过 `interactive_bash`（tmux）执行每一步。

## 如何运行

在不同的 tmux session 中启动两个 opencode session：

```bash
# 终端 1（session A）
tmux new-session -d -s xsm-A 'cd /tmp/xsm-repoA && opencode'

# 终端 2（session B）
tmux new-session -d -s xsm-B 'cd /tmp/xsm-repoB && opencode'
```

两个仓库至少需要一个空的 git init。所有 5 个场景都使用此设置；跨项目场景需要两个不同的仓库路径。

证据保存路径：`.sisyphus/evidence/task-17-scenarioN-<slug>.log`（两个窗格的 tmux 截取）。

---

## 场景 1：正常路径（同一项目）

### 前置条件
- Registry 文件 `~/.local/state/opencode/agents-registry.json` 为空或不存在。
- Session A 和 Session B 都运行在同一个仓库中（`/tmp/xsm-happy`）。

### 设置命令
```bash
mkdir -p /tmp/xsm-happy && cd /tmp/xsm-happy && git init && git commit --allow-empty -m init
tmux new-session -d -s A 'cd /tmp/xsm-happy && opencode'
tmux new-session -d -s B 'cd /tmp/xsm-happy && opencode'
```

### 步骤
1. 在 session A 中：调用 `register_session`，摘要为 `"session A working on happy-path test"`。
2. 在 session B 中：调用 `register_session`，摘要为 `"session B ready to answer"`。
3. 在 session A 中：调用 `list_sessions` — 验证 B 出现在列表中并显示其摘要。
4. 在 session A 中：调用 `ask_session sessionId=<B 的 id> question="What is 2+2? Answer with just the number, no other text."`。
5. 等待；A 的工具调用应返回 B 的回复。

### 预期结果
A 收到包含 `"4"` 的回复字符串；对于这个简单问题，工具调用端到端耗时应 < 30 秒。

### 需要采集的证据
- `.sisyphus/evidence/task-17-scenario1-happy.log`（两个窗格的 tmux 截取）

### 结果（在 T17 执行时填写）
- PASS / FAIL：_待定_

---

## 场景 2：目标繁忙等待路径

### 前置条件
- 两个 session 都在运行。
- 在 A 的提问到达前，B 会被分配一个长时间运行的任务。

### 设置命令
与场景 1 相同。

### 步骤
1. 两个 session 都已注册。
2. 在 session B 中：发送一个长时间运行的 prompt（例如 `"read /etc/passwd, count the lines, then write a 500-word explanation of the file format"`）——这会让 B 忙碌 30–60 秒。
3. 在 B 仍在工作时，在 session A 中：调用 `ask_session sessionId=<B> question="After you finish your current task, what is the capital of France? Reply with just the city name."`。
4. 计算从 A 发出提问到 A 收到回复的时间间隔。

### 预期结果
- A 的工具调用**不会**立即报错——它会**等待** B 完成当前任务。
- B 完成并处理 A 的提问后，A 收到 `"Paris"`（或等价的简短回复）。
- `A 发问到收到回复的时间 >= B 完成原始任务所需时间`。

### 需要采集的证据
- `.sisyphus/evidence/task-17-scenario2-busywait.log`

### 结果（在 T17 执行时填写）
- PASS / FAIL：_待定_

---

## 场景 3：超时路径

### 前置条件
- Session A 正在运行。
- Session B 要么无响应（卡在一个很长的任务中），要么被故意模拟为卡住状态。

### 设置命令
基础设置相同。要在不运行真实 30 分钟任务的情况下模拟 B 卡住，可使用较小的 `timeoutMs`（例如 `5000`）。

### 步骤
1. 两个 session 都已注册。
2. 让 B 进入一个故意长时间运行的任务（例如无限循环，或慢速 shell 命令如 `sleep 60`）。
3. 在 session A 中：调用 `ask_session sessionId=<B> question="hello?" timeoutMs=5000`。
4. 验证 A 的工具在约 5–6 秒内返回错误字符串。

### 预期结果
A 收到包含 `"did not respond within 5000ms"`（或如果繁忙等待预算先触发则为 `"did not become idle within"`）的文本错误。不抛异常。不会挂起超过约 6 秒。

### 需要采集的证据
- `.sisyphus/evidence/task-17-scenario3-timeout.log`

### 结果（在 T17 执行时填写）
- PASS / FAIL：_待定_

---

## 场景 4：跨项目路径

### 前置条件
- 两个**不同的** git 仓库：`/tmp/xsm-repoA` 和 `/tmp/xsm-repoB`。
- 每个仓库中运行一个 session。

### 设置命令
```bash
mkdir -p /tmp/xsm-repoA /tmp/xsm-repoB
git -C /tmp/xsm-repoA init && git -C /tmp/xsm-repoA commit --allow-empty -m init
git -C /tmp/xsm-repoB init && git -C /tmp/xsm-repoB commit --allow-empty -m init
tmux new-session -d -s A 'cd /tmp/xsm-repoA && opencode'
tmux new-session -d -s B 'cd /tmp/xsm-repoB && opencode'
```

### 步骤
1. 两个 session 都调用 `register_session`。
2. 在 session A 中：调用 `list_sessions` — 验证 B 出现在列表中，`directory` 为 `/tmp/xsm-repoB`，`projectId` 与 A 不同。
3. 在 session A 中：调用 `ask_session sessionId=<B> question="What is 2+2? Reply with just the number."`。
4. 等待回复。

### 预期结果
跨项目提问与同项目正常路径行为完全一致。A 的 `list_sessions` 显示两条记录，具有不同的 `directory` 和 `projectId`。A 收到 B 的回复。

### 需要采集的证据
- `.sisyphus/evidence/task-17-scenario4-crossproject.log`

### 结果（在 T17 执行时填写）
- PASS / FAIL：_待定_

---

## 场景 5：Session 未找到路径

### 前置条件
- 至少 session A 正在运行且已注册。

### 步骤
1. 在 session A 中：调用 `ask_session sessionId=ses_zzz_bogus_9999 question="hi"`。
2. 读取返回的文本。

### 预期结果
A 收到文本错误，提及：
- 该 session 不在 registry 中（或已被删除）。
- 提示调用 `list_sessions` 刷新列表。

不抛异常。不挂起。

### 需要采集的证据
- `.sisyphus/evidence/task-17-scenario5-notfound.log`

### 结果（在 T17 执行时填写）
- PASS / FAIL：_待定_

---

## 附加：`session.deleted` 清理冒烟测试

### 前置条件
- 场景 1 或场景 4 已成功执行——B 已注册。

### 步骤
1. 终止 session B（Ctrl-C 退出 TUI，或 `tmux kill-session -t B`）。
2. 等待 2 秒。
3. 在 session A 中：调用 `list_sessions`。

### 预期结果
Session B **不再**出现在 A 的列表输出中——`session.deleted` 钩子已将其清除。如果 B 仍然显示，24 小时 TTL 是兜底机制（如果测试是新运行的，这不算此场景的失败，但说明钩子本身没有触发）。

### 需要采集的证据
- `.sisyphus/evidence/task-17-prune.log`

### 结果（在 T17 执行时填写）
- PASS / FAIL：_待定_
