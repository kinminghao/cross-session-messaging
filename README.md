# cross-session-messaging

一个 [OpenCode](https://opencode.ai) **plugin**,让同一个 daemon 里的多个 session 互相通信:任何 session 都能把自己的任务概要注册到共享 registry,查看其他活跃 session,并向指定 session 发起一次**阻塞式提问**——由对方的 AI 自动生成回复。

> **状态**:核心已实现——3 个工具 + `session.deleted` 事件钩子 + **60 个单元测试 0 fail** + `tsc --noEmit` 干净。
> **尚未在真实 opencode daemon 上加载运行过**——需要装进 `opencode.json` 再跑一遍 5 场景 E2E 才算完全稳。

## 为什么

多 agent 编排场景下,session 之间需要跨会话交换上下文,但 opencode 本身没有内置的"A 问 B"原语。这个 plugin 补上这一层,并且**必须做成 in-process plugin**——外部 MCP server 的 HTTP 超时会打断长时间等待,而 in-process plugin 的 `execute()` 没有这个限制。

## 三个工具

| 工具 | 用途 |
|---|---|
| `register_session(summary)` | 把当前 session 的任务概要广播到共享 registry |
| `list_sessions(includeSelf?)` | 读 registry,给 `ask_session` 挑目标(默认过滤掉自己;>24h 陈旧条目自动隐藏) |
| `ask_session(sessionId, question, timeoutMs?)` | 向目标 session 发问 + 等 AI 回复。**从不 throw**——所有失败路径都返回可读的错误文本 |

`ask_session` 的默认超时 60 秒,上限 10 分钟。目标忙时会先退避轮询等它变 idle,再送达;总预算耗尽或 abort 时干净地返回错误文本。

## 存储位置

Registry 文件:`~/.local/state/opencode/agents-registry.json`(或 `$XDG_STATE_HOME/opencode/agents-registry.json`)。

**全局路径**——放在用户级而不是项目级,这样跨 git 仓库的 session 也能互相发现。

写入策略:temp 文件 + `fs.rename` **原子替换** + 进程内 mutex 链,保证并发安全。每个条目额外带 24h 陈旧 TTL,作为 `session.deleted` 事件万一漏触发时的兜底。

## 安装

**当前尚未发布到 npm**,请用本地绝对路径挂进 `~/.config/opencode/opencode.json`(注意是 `opencode.json`,**不是** `tui.json`——这是普通 plugin 不是 TUI plugin):

```json
{
  "$schema": "https://opencode.ai/opencode.json",
  "plugin": ["/绝对路径/cross-session-messaging/src/index.ts"]
}
```

发布到 npm 后可以改成包名:

```json
{
  "$schema": "https://opencode.ai/opencode.json",
  "plugin": ["cross-session-messaging"]
}
```

改完配置**完全退出并重新打开** opencode。

## 开发

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # 60 tests / 9 files
```

## 目录结构

```
src/
├── index.ts                # 入口(PluginModule 默认导出)
├── constants.ts            # PLUGIN_ID、超时、退避、TTL 等常量
├── xdg.ts                  # XDG_STATE_HOME 解析 + getRegistryPath()
├── types.ts                # RegistryEntry / Registry / arg 接口 / 4 个 Error 子类
├── logger.ts               # 打 PLUGIN_ID 标签的日志辅助
├── registry.ts             # 原子文件 I/O + 进程内 mutex
├── eventHooks.ts           # session.deleted 事件处理器工厂
├── waitForIdle.ts          # session.status 退避轮询(供 ask_session 用)
├── askAndWaitForReply.ts   # subscribe-first + sentAt 过滤 + finally cleanup
└── tools/
    ├── registerSession.ts  # 工具:register_session
    ├── listSessions.ts     # 工具:list_sessions
    └── askSession.ts       # 工具:ask_session
SKILL.md                    # LLM-facing 使用指南(skill 定义)
test/manual/
└── MANUAL_TEST_PLAN.md     # 5 场景 E2E 手工测试计划(happy / busy-wait / timeout / 跨项目 / 目标不存在)
```

## 已知限制

- **无死锁检测**:如果 A 等 B、B 又反过来问 A,两边会各自超时失败,不会立即报错。MVP 阶段用超时兜底,不做主动检测。
- **无鉴权**:默认单用户可信环境,任何知道 sessionId 的 session 都能发消息。多用户/多租户场景需要重新设计。
- **无消息队列**:一次 `ask_session` 从头到尾是一次原子请求,不做排队 / 重试。
- **无跨会话历史**:每次 `ask_session` 对目标而言是全新的一次任务——被问的 session **完全看不到**提问方的会话历史。所以 `question` 参数**必须自包含**(把背景、代码片段、约束都写在里面)。

## 相关文档

- [`SKILL.md`](./SKILL.md) — LLM 使用指南,规定何时调用哪个工具、如何写自包含的 question、常见坑
- [`test/manual/MANUAL_TEST_PLAN.md`](./test/manual/MANUAL_TEST_PLAN.md) — 5 个真实 opencode 环境下的端到端场景脚本

## License

MIT
