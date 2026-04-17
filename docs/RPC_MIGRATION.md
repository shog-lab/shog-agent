# 迁移到 pi-coding-agent RPC 模式

## 背景

当前 `pi-agent-runner/` 在 pi-coding-agent SDK 外面包了一层壳：手动创建 session、subscribe 事件收集 resultText、IPC 文件轮询 follow-up、stdout marker 协议。而 pi-coding-agent 内建的 RPC 模式（`pi --mode rpc`）已经提供了完整的 JSON stdin/stdout 协议，覆盖了这些能力。

## 两层 Pi 运行时架构

```
用户消息 → 宿主进程(Node.js)
              │ stdin/stdout (RPC JSON)
              ▼
    ┌─────────────────────────────────┐
    │  Group Container                │
    │                                 │
    │  L1: pi --mode rpc              │  ← 常驻，管记忆/对话/决策
    │  cwd: /workspace/group          │
    │  extensions: memory, jimeng     │
    │  skills: group skills           │
    │                                 │
    │  需要改代码时 (Bash 工具):       │
    │  ┌───────────────────────────┐  │
    │  │ L2: pi -p "prompt"       │  │  ← 临时子进程，改完退出
    │  │ cwd: /workspace/repos/xx │  │
    │  │ 无自定义 extensions      │  │
    │  └───────────────────────────┘  │
    └─────────────────────────────────┘

通信方式:
  宿主 → L1: stdin JSON (prompt, follow_up, abort)
  L1 → 宿主: stdout JSON 事件流
  L1 → 宿主 (send_message, schedule_task): IPC 文件（保留现有机制）
  L1 → L2: Bash 工具执行 `pi -p`，stdout 直接拿结果
```

### L1 vs L2 职责

| | L1 (Group Agent) | L2 (Repo Agent) |
|---|---|---|
| 生命周期 | 常驻（IDLE_TIMEOUT 30 分钟） | 临时（单次任务，完成退出） |
| cwd | `/workspace/group` | `/workspace/repos/{repo}` |
| 记忆 | 有（memory extension + wiki） | 无 |
| skills | group skills | 无（靠 repo 的 CLAUDE.md） |
| 权限 | 读写 group 目录，只读 repo（system prompt 约束） | 读写目标 repo |
| 启动方式 | 宿主 spawn 容器 + RPC | L1 Bash 工具 `pi -p` |
| 超时 | 宿主控制 | L1 Bash timeout / skill 控制 |

### 安全模型

- **物理隔离替代代码校验**：容器只 mount 白名单 repo，未 mount 的目录不存在。`risk-scorer.ts`、`verify-command.ts`、`validateRepo` 全部删除。
- **L1 不碰 repo 代码**：通过 system prompt 约束 L1 不直接修改 `/workspace/repos/` 下的文件，改代码一律通过 L2（`pi -p`）。
- **Git 操作容器内完成**：SSH key 只读挂载 `~/.ssh/:ro`，容器镜像已有 git。
- **鉴权共享**：L1 和 L2 在同一容器，共享 `ANTHROPIC_BASE_URL`（credential proxy），无需额外配置。

## 现状 vs 目标

| | 现状 | RPC 模式 |
|---|---|---|
| 容器入口 | `pi-agent-runner/src/index.ts`（自建 main loop） | `pi --mode rpc`（官方 CLI） |
| 消息输入 | stdin 初始 prompt + IPC 文件轮询 follow-up | stdin JSON `{"type":"prompt"}` / `{"type":"follow_up"}` |
| 消息输出 | stdout `---SHOG_OUTPUT_START---` marker 解析 | stdout JSON 事件流 |
| session 管理 | 手动 createAgentSession + sessionId 传递 | 内建，支持 `new_session` / `switch_session` |
| 中断执行 | IPC `_close` sentinel 文件 | `{"type":"abort"}` |
| 对话历史 | 手动 archiveTranscript | `{"type":"get_messages"}` |
| extensions | 手动加载（entrypoint.sh 同步到 pi 目录） | 自动加载（`~/.pi/agent/extensions/`） |
| skills | 自动发现（DefaultResourceLoader） | 自动发现（同上） |
| compaction | 依赖 SDK 内部行为 | `{"type":"compact"}` 可主动触发 |
| 模型切换 | 环境变量，重启容器 | `{"type":"set_model"}` 运行时切换 |
| 代码执行 | 容器 IPC → 宿主 spawn Claude Code CLI | 容器内 L1 Bash 调 `pi -p` |

## 迁移步骤

### Phase 1：宿主侧改造

**container-runner.ts：**
1. stdin 改为 JSON 写入（不再 `stdin.end()`，保持 stdin 打开）
2. stdout 改为逐行 JSON 解析（废弃 `SHOG_OUTPUT_*` marker）
3. follow-up 从 IPC 文件改为 stdin `{"type":"follow_up"}`
4. 关闭容器从 `_close` sentinel 改为 `{"type":"abort"}` 或关闭 stdin

**group-queue.ts：**
1. `sendMessage()` 从写 IPC 文件改为向容器 stdin 写 JSON
2. `closeStdin()` 从写 `_close` 文件改为发 abort 命令

**container 启动改造：**
1. Dockerfile 入口改为 `pi --mode rpc`
2. entrypoint.sh 保留（extension/schema/wiki-config 同步）
3. system prompt 通过 `--append-system-prompt` 注入
4. group skills 通过 `--skill /workspace/group/skills/*` 或 symlink `.pi/skills` 注入
5. 目标 repo 按 group 配置的 `codeRepos` mount 到 `/workspace/repos/`
6. SSH key mount `~/.ssh/:ro`

### Phase 2：废弃自建代码

**删除：**
- `container/pi-agent-runner/src/index.ts` 的 main loop（IPC 轮询、subscribe、writeOutput、archiveTranscript）
- `container/pi-agent-runner/src/ipc-tools.ts` 中 `exec_ralph` / `exec_claude` 工具定义
- `src/claude-code.ts`（整个文件）
- `src/risk-scorer.ts`（整个文件）
- `src/verify-command.ts`（整个文件）
- `src/git-worktree.ts`（整个文件）
- `src/ipc.ts` 中 `exec_ralph` / `exec_claude` handler
- `data/ipc/*/input/` 目录机制

**保留：**
- `src/ipc.ts` 中 send_message / schedule_task / delegate_task handler（容器 → 宿主 IPC 文件）
- `container/pi-agent-runner/src/ipc-tools.ts` 中 send_message / schedule_task 等工具（仍通过 IPC 文件通知宿主）
- `container/extensions/`（memory、jimeng — 通过 entrypoint.sh 同步到 `~/.pi/agent/extensions/`）

**改造：**
- `container/pi-agent-runner/src/ipc-tools.ts`：删掉 exec_ralph/exec_claude，保留其余 IPC 工具。这些工具需要以 pi extension 的形式注册，而非通过 SDK 的 `customTools`。
- ralph / exec_claude skill：改写调用方式，从 `exec_ralph({...})` 改为 `pi -p --cwd /workspace/repos/xxx "prompt"`

### Phase 3：验证和清理

1. 用 claw CLI 测试 L1 对话正常
2. 测试 L1 → L2 代码修改链路（Bash 调 pi -p）
3. 测试 send_message IPC 仍然正常（发钉钉）
4. 测试 schedule_task 仍然正常
5. 删除所有相关测试文件中的废弃测试
6. 更新 CLAUDE.md、docs、skills 文档

## 已验证

- RPC 模式下 extensions 正常加载（2026-04-16 确认：`createRuntime` 在 mode 判断之前执行，所有模式共享同一初始化流程）
- skills 格式兼容（SKILL.md + name/description frontmatter，多余字段忽略不报错）
- CLI 支持 `--extension`、`--skill`、`--append-system-prompt` 参数
- print 模式（`pi -p`）可作为 L2 执行者，支持 `--cwd` 指定工作目录

## 风险

- pi-coding-agent RPC 协议是第三方 SDK，版本升级可能 break 协议
- RPC 模式在 ShogAgent 场景下的稳定性未经长时间验证
- L1 对 repo 目录的约束靠 system prompt，非物理隔离（后续可通过 Linux 用户权限解决）
- `pi-agent-runner/src/ipc-tools.ts` 中非 exec 工具需要适配为 pi extension 格式，注册方式有变化

## 设计决策记录

### 为什么保留两层 agent 而不合并？

Group agent（L1）和 Repo agent（L2）是多对多关系：一个 group 可以管多个 repo，一个没有 repo 的 group（如 dingtalk-shog）也需要运行。两层有不同的 cwd、不同的权限范围、不同的生命周期。合并会导致记忆系统和代码修改上下文互相污染。

### 为什么宿主 → 容器用 RPC，容器 → 宿主用 IPC 文件？

RPC 模式下 stdin/stdout 被 pi 占用。容器内 `send_message` 等工具无法通过 stdout 通知宿主（会混入 pi 事件流）。IPC 文件是容器和宿主之间唯一独立的共享通道。

### 为什么 L1 用 Bash 调 L2 而不是 IPC？

L1 和 L2 在同一容器内，Bash `pi -p` 最简单直接——不需要文件轮询、不需要 response 文件、stdout 就是结果。`exec_ralph` / `exec_claude` 这两个 IPC 工具可以直接删除。

### 为什么删除 risk-scorer 等安全代码？

容器只 mount 白名单 repo（`codeRepos` 配置），未 mount 的目录在容器内不存在。物理隔离比代码校验更可靠。
