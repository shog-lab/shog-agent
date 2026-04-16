# 迁移到 pi-coding-agent RPC 模式

## 背景

当前 `pi-agent-runner/` 在 pi-coding-agent SDK 外面包了一层壳：手动创建 session、subscribe 事件收集 resultText、IPC 文件轮询 follow-up、stdout marker 协议。而 pi-coding-agent 内建的 RPC 模式（`pi --mode rpc`）已经提供了完整的 JSON stdin/stdout 协议，覆盖了这些能力。

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

## 迁移步骤

### Phase 1：宿主侧改造（container-runner.ts）

1. **stdin 改为 JSON 写入**：不再 `container.stdin.write(JSON.stringify(input)); container.stdin.end()`，改为持续写入 JSON 命令
2. **stdout 改为 JSON 解析**：废弃 `SHOG_OUTPUT_START/END` marker 解析，改为逐行 JSON parse
3. **follow-up 从文件改为 stdin**：`group-queue.sendMessage()` 不再写 IPC 文件，改为向容器 stdin 写 `{"type":"follow_up","message":"..."}`
4. **关闭容器从 sentinel 文件改为命令**：不再写 `_close` 文件，改为发 `{"type":"abort"}` 或直接关闭 stdin

### Phase 2：废弃 pi-agent-runner

1. **删除 `container/pi-agent-runner/src/index.ts` 的 main loop**：IPC 轮询、subscribe 事件收集、writeOutput、archiveTranscript 全部不需要
2. **Dockerfile 改入口**：从 `node /app/dist/index.js` 改为 `pi --mode rpc`
3. **保留 entrypoint.sh**：extension 同步、schema 同步逻辑仍然需要
4. **system-prompt.md 注入方式调整**：改用 `pi --mode rpc --append-system-prompt "$(cat /app/system-prompt.md)"` 或通过 settings

### Phase 3：Pi 做 Ralph 执行者

1. **容器内执行 Ralph**：`pi --mode rpc` 在同一容器（或 sibling 容器）内执行代码修改
2. **目标 repo 通过 volume mount**：读写挂载目标 repo，SSH key 只读挂载
3. **废弃宿主侧 exec_ralph / exec_claude IPC 链路**：不再穿透容器边界调用宿主 Claude Code CLI
4. **repo 兼容性**：.claude/.pi 配置由 repo 维护者自行处理，ShogAgent 不管

## 可废弃的代码

迁移完成后可以删除：

- `container/pi-agent-runner/src/index.ts` 大部分代码（main loop、IPC 轮询、subscribe 收集、writeOutput marker）
- `src/container-runner.ts` 的 marker 解析逻辑（`OUTPUT_START_MARKER` / `OUTPUT_END_MARKER`）
- `src/group-queue.ts` 的 `sendMessage()` IPC 文件写入
- `data/ipc/*/input/` 目录机制

## 已验证

- RPC 模式下 extensions 正常加载（2026-04-16 确认：`createRuntime` 在 mode 判断之前执行，所有模式共享同一初始化流程）
- skills 格式兼容（SKILL.md + name/description frontmatter，多余字段忽略不报错）
- CLI 支持 `--extensions` 参数额外注入 extension 路径

## 风险

- pi-coding-agent RPC 协议是第三方 SDK，版本升级可能 break 协议
- RPC 模式在 ShogAgent 场景下的稳定性未经长时间验证
- system prompt 注入方式需要确认（`--system-prompt` / `--append-system-prompt` 参数是否在 RPC 模式下生效）
