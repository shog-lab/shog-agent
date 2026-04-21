# ShogAgent Pi Architecture

本文档只保留当前仍然有效的架构事实、目录映射、关键约束与运行方式。

历史改动记录、阶段性 TODO、路线图与设计背景已迁移到 shog wiki。

## 当前架构

ShogAgent 当前采用三层 agent 架构：

| 层级 | 模式 | 工作目录 | 谁控制 | Extensions | Skills |
|---|---|---|---|---|---|
| L1 (Group Agent) | `pi --mode rpc`（容器） | `/workspace/group` | 宿主进程 | memory/ipc/web/jimeng | group skills |
| L2 (Repo Sub-Agent / Executor) | `pi -p`（容器内子进程） | 目标仓库 | L1 | web | repo skills（自动发现） |
| L3 (Local CLI) | `pi` 交互模式（本地） | repo 目录 | 用户 | memory + web | group + repo skills |

补充约束：
- repo 内所有写操作统一由 L2 执行
- L1 负责理解需求、拆任务、生成计划，但不直接写 repo
- 如需把 PRD、progress 等文件落到 repo，由 L2 先写入，再继续执行

## 当前能力分层

| 层 | 内容 | agent 可修改 |
|---|---|---|
| ShogAgent | 宿主进程 `src/`，通过 RPC JSON 协议与容器通信 | 否 |
| Agent | pi-coding-agent（`pi --mode rpc`）、pi SDK | 否 |
| Extension Layer | skills、extensions、AGENTS.md、prompts | 是（受治理约束） |

## 内建 vs group 自定义

| 层 | 来源 | agent 可改 | 说明 |
|---|---|---|---|
| 内建 | `container/skills/`、`container/extensions/` | 否 | 平台内建能力 |
| group 自定义 | `groups/{name}/skills/` 等 | 是 | group 持久化工作流与能力 |

## 目录职责

| 目录 | 内容 | 用途 |
|---|---|---|
| `groups/{name}/wiki/` | LLM Wiki | 长期知识 |
| `groups/{name}/raw/conversations/` | 对话全文归档 | 审计 |
| `groups/{name}/raw/logs/` | 运行日志 | 排障 / 审计 |
| `groups/{name}/raw/artifacts/` | 测试与执行产物 | 黑盒验证 |
| `groups/{name}/raw/mailbox/` | 治理上报与通信留痕 | 审计 / 扩展接口 |
| `data/sessions/{name}/.pi/agent/` | 每个 group 的 pi session | 隔离运行态 |

## 关键挂载

### 构建时写入镜像

| 宿主机源码 | 容器内路径 | 说明 |
|---|---|---|
| `container/pi-agent-runner/package.json` | `/app/` | 安装 pi-coding-agent |
| `container/skills/` | `/app/skills/` | 内建 skills |
| `container/system-prompt.md` | `/app/system-prompt.md` | 系统提示模板 |

### 运行时挂载

| 宿主机路径 | 容器内路径 | 读写 | 说明 |
|---|---|---|---|
| `groups/{name}/` | `/workspace/group/` | 读写 | group 工作目录 |
| `groups/global/` | `/workspace/global/` | 只读 | 全局记忆 |
| `data/sessions/{name}/.pi/agent/` | `/home/node/.pi/agent/` | 读写 | pi sessions |
| `~/.pi/agent/auth.json` | `/home/node/.pi/agent/auth.json` | 读写 | OAuth 认证 |
| group IPC 目录 | `/workspace/ipc/` | 读写 | 进程间通信 |

## 当前运行机制

### Channel

当前 channel 采用插件化注册：
- 核心代码只依赖 `Channel` 接口能力
- 新增 channel 通过实现接口并注册接入
- 当前主要 channel：钉钉、微信

### 认证

- 容器共享宿主 `~/.pi/agent/auth.json`
- 避免多容器 refresh token 竞争
- 容器内不直接暴露真实上游密钥，由宿主代理注入

### 治理

- 只有 meta-agent 负责治理性修改
- 普通 group 不自行修改 AGENTS.md、extensions、治理规则
- 普通 group 通过治理上报通道向 meta-agent 上报问题

## 当前与原版的主要区别

| | 原版 ShogAgent | 当前 Pi 版 |
|---|---|---|
| AI 引擎 | Claude Agent SDK | pi-coding-agent |
| 消息渠道 | WhatsApp | 钉钉 / 微信 |
| 运行模式 | 自定义 agent runner | `pi --mode rpc` |
| 记忆系统 | 原始对话 dump 为主 | wiki + raw + schema |
| repo 执行 | 不同实现 | L1 规划 + L2 执行 |

## 当前更新流程

| 改什么 | 怎么更新 |
|---|---|
| 宿主进程（`src/`） | 改代码 → `pm2 restart shog-agent` |
| 容器内容（skills、extensions、system-prompt） | 改代码 → `./container/build.sh` |
| 模型 / 凭证（`.env`） | 改配置 → 重启宿主进程 |
| OAuth 登录 | `pi /login openai-codex`（首次或 token 失效时） |

## 关键文件索引

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 主入口：状态管理、消息循环、agent 调度 |
| `src/container-runner.ts` | 挂载、启动容器、RPC 协议通信 |
| `src/group-queue.ts` | group 级容器与消息队列 |
| `src/ipc.ts` | IPC watcher 与宿主代处理逻辑 |
| `src/task-scheduler.ts` | 定时任务调度 |
| `src/db.ts` | SQLite 数据持久化 |
| `container/system-prompt.md` | 系统提示模板 |
| `container/extensions/ipc/` | IPC extension |
| `container/extensions/web/` | Web extension |
| `container/extensions/memory/` | Memory extension |

更多历史背景、路线与改动记录见 shog wiki。
