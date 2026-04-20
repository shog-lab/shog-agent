# ShogAgent Pi 版架构

本文档记录 shog-lab/shog-agent fork（pi-coding-agent 魔改版）的架构决策、速查表和改动记录。

> 技术分享版本见 [PRESENTATION.md](PRESENTATION.md)

---

## TODO

### 当前优先级

#### 1. 记忆系统持续优化
- [ ] **提升 LongMemEval 分数**：当前 77.4%，temporal-reasoning 58.6% 是短板
- [ ] **更好的 embedding 模型**：尝试 mxbai-embed-large 或其他，对比 nomic-embed-text
- [ ] **rerank**：检索后用 LLM 重排，提升精度
- [ ] **FTS5 中文分词**：当前 unicode61 tokenizer 不分词连续中文，召回率低

#### 2. 工程质量改进
详见 [ENGINEERING_QUALITY.md](ENGINEERING_QUALITY.md)。

#### 3. 自进化闭环
详见 [EVOLUTION.md](EVOLUTION.md)。
- [ ] **主 group 管理 ShogAgent 代码**：shog 通过 L2 Repo Agent 改 ShogAgent 自身代码（wiki-config.json 折中方案已实现，完整版需要 codeRepos 挂载）

#### 4. 其他
- [ ] **LongMemEval 词项匹配版消融实验**：差最后一组基线数据
- [ ] **SWE-Bench**：验证 L2 Repo Agent 的代码修复能力
- [ ] **钉钉端到端验证**：黑盒测试通过 cli 验证通过，但钉钉群触发未验证

### 已完成

- ~~OneCLI 集成~~ → 已删除，用 native credential proxy
- ~~每个 group 独立进化~~ → 已集中到主 group（daily-review + autoresearch-loop）
- ~~coding pipeline（容器内写代码）~~ → 丢弃，现由 L1→L2 双层 agent 在容器内完成
- ~~FTS5 全文搜索~~ → 已实现
- ~~向量搜索~~ → 已实现（Ollama nomic-embed-text）
- ~~L1 分层加载~~ → 已实现（preference/decision/fact，2000 tokens）
- ~~知识图谱~~ → 已实现（auto-extract + 手动 triples）
- ~~Ralph 集成~~ → 已删除 exec_ralph/exec_claude，改用 L1→L2 双层 agent 架构
- ~~LLM Wiki~~ → 统一记忆系统（wiki/ + raw/ + schema/，自动修复 frontmatter，[[link]] 互联）
- ~~黑盒测试~~ → L2 Repo Agent + agent-browser + artifacts 目录
- ~~code-patrol~~ → 定时巡检 + 用户许可后触发修复
- ~~LLM Wiki 纳入记忆~~ → 已实现（多目录扫描）
- ~~Runtime self-improvement~~ → 已加入系统提示
- ~~任务评估（task-logs）~~ → 已加入系统提示
- ~~类型权重 / 动态条数 / 过期衰减~~ → 已实现
- ~~pidfile 防重复进程~~ → 已实现
- ~~RPC 迁移~~ → 容器入口改为 `pi --mode rpc`，宿主通过 RPC JSON 协议通信
- ~~exec_ralph / exec_claude~~ → 已删除，L1 通过 Bash 工具直接启动 L2（`pi -p`）
- ~~risk-scorer / verify-command~~ → 已删除，物理容器隔离替代代码级安全检查
- ~~pi-agent-runner 自定义主循环~~ → 已删除（index.ts, ipc-tools.ts, web-tools.ts），改用 pi 内建 RPC 模式 + extensions

---

## 架构决策

### 三层自进化模型

agent 的能力分三层，只有 Extension 层允许自修改：

| 层 | 内容 | agent 可修改 |
|---|------|------------|
| **ShogAgent** | 宿主进程 `src/`，通过 RPC JSON 协议与容器通信 | 否（跑在容器外） |
| **Agent** | pi-coding-agent（`pi --mode rpc`）、pi SDK | 否（镜像内只读） |
| **Extension** | skills、extensions、AGENTS.md、prompts | 是 |

### 内建 vs 自创的双层模式

skills 和 extensions 都分两层：

| 层 | 来源 | agent 可改 | 说明 |
|---|------|-----------|------|
| 内建 | `container/skills/`、`container/extensions/` → 同步到 pi agent 目录 | 否（只读挂载） | 你控制的核心能力 |
| 自创 | `groups/{name}/skills/`、`groups/{name}/.pi/extensions/` | 是（读写挂载） | agent 运行时创建的 |

### conversations/ 和 memory/ 的职责分离

| 目录 | 写入者 | 内容 | 用途 |
|------|--------|------|------|
| `conversations/` | archiveTranscript（自动） | 对话全文 dump | 审计日志，给你看的 |
| `memory/` | mem extension + agent 自主写入 | 选择性记忆（frontmatter + 要点） | 长期记忆，给 agent 用的 |

### auth.json 共享挂载

所有容器直接挂载宿主机的 `~/.pi/agent/auth.json`（文件挂载覆盖在目录挂载之上），不再复制到每个 group 目录。解决了多容器同时刷新 OAuth token 导致 `refresh_token_reused` 的竞争问题。

### Channel 插件化

Channel 接口声明能力（`handlesOwnTrigger`、`setTyping`、`syncGroups`），核心代码只看接口属性，不看具体是哪个 channel。新增 channel 只需实现 `Channel` 接口 + `registerChannel()`，不用改 `index.ts`。

### 记忆系统：为什么不用向量数据库

当前记忆系统用 Markdown 文件 + 关键词匹配。没有引入向量数据库和 embedding 的原因：

- 当前记忆量很小（每个 group 几个到十几个 md 文件），关键词匹配够用
- 向量数据库需要引入 embedding 服务（多一个 API 依赖和成本）、维护索引、处理容器内访问
- 复杂度上一个台阶，但当前阶段收益为零

等单个 group 的 memory 文件多到几百个、关键词匹配开始漏召回时再考虑。

### Evolution Loop：为什么不让每个 group 独立进化

当前只有主 group 跑 evolution-loop（凌晨 3 点），普通 group 不独立进化。原因：

- 不是架构限制——每个 group 都有自己的 conversations 和 memory，技术上可以独立复盘
- 是实际需求不足——当前普通 group 数量少、对话量不大，单独跑一个容器做进化投入产出不合理
- 主 cli 有全局视角（只读挂载了所有 group 的 conversations），可以统一复盘，发现问题通过 delegate_task 让普通 group 自己改进

等 group 数量和对话量增长后，可以给每个 group 注册独立的 evolution-loop。

---

## 速查表

### 和原版的区别

| | 原版 ShogAgent | Pi 魔改版 |
|---|---|---|
| AI 引擎 | Claude Agent SDK | pi-coding-agent |
| 模型 | Claude (Anthropic API) | `.env` 的 `MODEL` 配置（默认 gpt-5.2-codex） |
| 认证方式 | Anthropic API Key + Credential Proxy | OAuth (auth.json) |
| 消息渠道 | WhatsApp (Baileys) | 钉钉 (Stream SDK) / 微信 (iLink Bot API) |
| Agent Runner | `container/agent-runner/` | `pi --mode rpc`（pi 内建 RPC 模式，无自定义 runner） |
| Dockerfile | `container/Dockerfile` | `container/Dockerfile.pi` |
| Skills 发现 | MCP Server | DefaultResourceLoader |
| 记忆系统 | archiveTranscript（全量 dump） | mem extension（选择性） + archiveTranscript（审计） |
| 构建命令 | `./container/build.sh` | `./container/build.sh pi` |

### 目录映射

构建时（Dockerfile.pi COPY 进镜像，固化不变）：

| 宿主机源码 | 容器内路径 | 说明 |
|---|---|---|
| `container/pi-agent-runner/package.json` | `/app/` | 安装 pi-coding-agent（仅 package.json，无自定义代码） |
| `container/skills/` | `/app/skills/` | 内建 skills |
| `container/system-prompt.md` | `/app/system-prompt.md` | 系统提示模板 |

运行时（docker run -v 挂载，每次启动时映射）：

| 宿主机路径 | 容器内路径 | 读写 | 说明 |
|---|---|---|---|
| `groups/{name}/` | `/workspace/group/` | 读写 | group 工作目录（记忆、skills、extensions、笔记） |
| `groups/global/` | `/workspace/global/` | 只读 | 全局记忆 |
| `data/sessions/{name}/.pi/agent/` | `/home/node/.pi/agent/` | 读写 | pi sessions、内建 skills/extensions |
| `~/.pi/agent/auth.json` | `/home/node/.pi/agent/auth.json` | 读写 | OAuth 认证（所有容器共享同一份） |
| IPC 目录 | `/workspace/ipc/` | 读写 | 进程间通信 |

### 更新流程

| 改什么 | 怎么更新 |
|--------|---------|
| 宿主进程（`src/`） | 改代码 → 重启 `npm run dev` |
| 容器内容（skills、extensions、system-prompt） | 改代码 → `./container/build.sh pi` |
| 模型/凭证（`.env`） | 改配置 → 重启宿主进程 |
| OAuth 登录 | `pi /login openai-codex`（仅首次或 token 失效时） |

### 关键文件索引

**宿主进程：**

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 主入口：状态管理、消息循环、agent 调度 |
| `src/channels/dingtalk.ts` | 钉钉 WebSocket 连接和消息收发 |
| `src/channels/weixin.ts` | 微信 iLink Bot API 长轮询消息收发 |
| `src/container-runner.ts` | 构建挂载、启动容器、RPC 协议通信（stdin/stdout JSON） |
| `src/router.ts` | 消息格式化和出站路由 |
| `src/config.ts` | 触发词、路径、超时等配置 |
| `src/db.ts` | SQLite 操作（消息、group 注册、图片缓存） |
| `src/task-scheduler.ts` | 定时任务调度 |

**容器进程（`pi --mode rpc`，无自定义 runner 代码）：**

| 文件 | 职责 |
|---|---|
| `container/system-prompt.md` | 系统提示模板（宿主进程注入变量后传给 pi） |
| `container/extensions/ipc/` | IPC pi extension（send_message, schedule_task 等） |
| `container/extensions/web/` | 联网 pi extension（web_search, web_fetch） |
| `container/extensions/memory/index.ts` | 长期记忆 extension |
| `container/skills/agent-browser/SKILL.md` | 浏览器自动化 skill |

**三层 agent 架构：**

| 层级 | 模式 | 工作目录 | 谁控制 | Extensions | Skills |
|---|---|---|---|---|---|
| L1 (Group Agent) | `pi --mode rpc`（容器） | `/workspace/group` | 宿主进程 | memory/ipc/web/jimeng | group skills |
| L2 (Executor) | `pi -p`（容器内子进程） | 目标仓库 | L1 | web | repo skills（自动发现） |
| L3 (Local CLI) | `pi` 交互模式（本地） | repo 目录 | 用户 | memory + web | group + repo skills |

**数据和配置：**

| 路径 | 说明 |
|---|---|
| `groups/{name}/AGENTS.md` | 每个 group 的 agent 人设 |
| `groups/{name}/memory/` | 长期记忆（mem extension） |
| `groups/{name}/conversations/` | 对话日志（archiveTranscript） |
| `groups/global/CLAUDE.md` | 全局记忆（所有 group 共享） |
| `data/sessions/{name}/` | 每个 group 的 pi session 数据 |
| `.env` | 钉钉凭证、助手名称、模型配置 |
| `~/.pi/agent/auth.json` | pi OAuth 登录凭证（宿主机） |
| `data/weixin-auth.json` | 微信 iLink Bot Token |
| `data/messages.db` | SQLite 数据库 |

---

## 改动记录

### 1. Pi-Coding-Agent 替换 Claude Agent SDK

**日期：** 2026-03-09

用 pi-coding-agent 替换原版的 Claude Agent SDK 作为容器内的 AI 引擎。

- 模型自由：不绑定 Anthropic API，可用 OpenAI（gpt-5.2-codex）、MiniMax 等
- 认证灵活：OAuth 登录，不需要 API Key
- 原版 `container/agent-runner/` 保留不动，两套并存

### 2. 钉钉（DingTalk）Channel

**日期：** 2026-03-09

使用 DingTalk Stream 模式（WebSocket 长连接），无需公网 URL。自注册模式，缺少环境变量时静默跳过。

### 3. 钉钉主动消息 API

**日期：** 2026-03-17

替换 `sessionWebhook` 为钉钉 OpenAPI 主动消息接口，区分群聊（`groupMessages/send`）和单聊（`oToMessages/batchSend`）。元数据持久化到 SQLite。

### 4. 手动触发机制

**日期：** 2026-03-17

往 `data/triggers/` 放 JSON 文件触发 agent，支持自定义 prompt 和历史消息回放。

### 5. schedule_task 新增 delay 类型

**日期：** 2026-03-17

新增 `delay` 类型：传毫秒数，执行一次后自动结束。宿主进程收到后转换为 `once` + `Date.now() + ms`。

### 6. 定时任务 prompt 优化

**日期：** 2026-03-17

改进 `[SCHEDULED TASK]` prompt 前缀，明确告知 agent 这是任务指令而非用户消息。

### 7. 钉钉群聊 @发送者（未生效）

**日期：** 2026-03-17

尝试在群聊发消息时加入 `at` 字段，但钉钉 `sampleText` 消息类型不支持 at。`sampleMarkdown` 支持但会渲染成卡片样式，不适合普通回复。已移除 at 逻辑，保留 `dingtalkId` 缓存供未来使用。

### 8. 钉钉图片消息支持（多模态）

**日期：** 2026-03-18

完整的多模态图片链路，支持 `text`、`picture`、`richText` 三种消息类型。图片通过 base64 编码经 IPC 传入容器，pi `session.prompt({ images })` 多模态输入。

### 9. access_token 过期自动刷新

**日期：** 2026-03-18

`sendMessage` 遇到 `InvalidAuthentication` 时调钉钉 OAuth 接口刷新 token 并重试。

### 10. DingTalk disconnect 修复

**日期：** 2026-03-18

调用 SDK 的 `disconnect()` 方法关闭 WebSocket。

### 11. 模型配置外部化

**日期：** 2026-03-20

从 `.env` 读取 `MODEL`（格式 `provider/model`，如 `openai-codex/gpt-5.2-codex`），宿主进程作为环境变量传入容器。

### 12. Channel 插件化：触发机制抽象

**日期：** 2026-03-20

`Channel` 接口新增 `handlesOwnTrigger?: boolean`，替代硬编码的 `dt:` 前缀检查。

### 13. Agent runner 安全加固

**日期：** 2026-03-20

去掉 `agent-runner-src` 可写挂载，entrypoint 直接用镜像预编译的 `dist/`。确立三层自进化模型。

### 14. 记忆系统（mem extension）

**日期：** 2026-03-23

通过 pi extension（`container/extensions/memory/`）实现选择性长期记忆。`session_compact` 自动保存摘要，`before_agent_start` 按关键词检索注入 system prompt。agent 自主写 `.md` 文件到 `memory/` 目录保存记忆。archiveTranscript 保留用于审计。

### 15. auth.json 共享挂载

**日期：** 2026-03-23

不再复制 auth.json 到每个 group，所有容器直接挂载宿主机的 `~/.pi/agent/auth.json`。修复多容器同时刷新 OAuth token 的竞争问题。

### 16. 自进化 Evolution Loop

**日期：** 2026-03-23

#### 设计思路

agent 的自我改进不应依赖用户手动触发，而应自主、持续、有据可依。

最初考虑了 DSPy 的 prompt 优化方法论（Signature → Module → Optimizer），但 DSPy 解决的是"编译期优化"（有标注数据集、离线批量跑），我们的场景是"运行时进化"（单用户、在线、无标注数据）。DSPy 能借鉴的核心思想是**改了之后要量化验证，不能凭感觉**，但具体流程需要自己设计。

架构经历了三轮简化：

1. **六步流水线**：Extract → Evaluate → Hypothesize → Test → Deploy → Monitor — 过于复杂
2. **四步流水线**：Extract → Evaluate+Improve → Deploy → Monitor — Monitor 可以合并到下一轮 Extract
3. **两步循环**：Review → Act — 最终方案，本质是一个超慢速的 ReAct 循环（天级而非秒级）

#### 实现

```
每天凌晨 3 点（定时任务自动触发）
  │
  ▼
Review（复盘）
  - 读 conversations/ 里最近的对话记录
  - 读 memory/ 里上次进化的记录（改了什么、效果如何）
  - 评估：哪些任务做得好、哪些做得差、上次改动是否有效
  │
  ▼
Act（行动）
  - 上次改动变差 → 回滚，记录原因
  - 发现新不足 → 改 AGENTS.md / 创建 skill / 优化已有 skill
  - 一切正常 → 不改，记录"现状良好"
  - 把决策写入 memory/evolution-{date}.md（改了什么、为什么、基于哪些对话）
  │
  ▼
下一轮 Review（自然形成闭环）
```

关键设计决策：

- **不需要新的基础设施** — 复用定时任务 + 现有文件读写能力 + memory extension
- **conversations/ 是唯一数据源** — archiveTranscript 的全量日志在此体现价值
- **memory/ 积累进化上下文** — 每次决策有记录，不会重复犯错，形成可追溯的进化链
- **每次只做一个改动** — 避免多个变量同时变化导致无法归因
- **改动必须基于具体对话证据** — 不靠"感觉"改 prompt

#### 改动文件

| 文件 | 改动 |
|------|------|
| `container/skills/evolution/SKILL.md` | evolution skill，描述 Review → Act 流程 |
| ~~`src/index.ts`~~ | ~~宿主进程启动时自动注册 `evolution-loop` 定时任务~~ → 已在 #20 去中心化中移除 |

> **注意：** #20（去中心化 evolution）已移除宿主端硬编码的 evolution 注册。现在由各 group agent 自己通过 `schedule_task` 注册，由 AGENTS.md 模板引导。

### 17. 多 agent 协作

**日期：** 2026-03-23

#### 设计思路

用户只与主 cli 交互，主 cli 在后台按需创建和调度内部 agent。每个 agent 是持久实体（非一次性 sub-agent），有独立容器、独立 AGENTS.md、独立记忆，长期积累专长。

与单 agent 的 sub-agent 模式的本质区别：**sub-agent 是函数调用（无状态、用完即弃），持久 agent 是团队成员（有记忆、会成长）。**

#### 架构

```
用户 @主cli："帮我做一期关于 AI Agent 的内容"
  │
  ▼
主 cli（容器 A）
  → 拆分任务
  → delegate_task("researcher", "找3个热门话题")
  │
  ▼
宿主进程路由
  → 启动 researcher 容器（独立上下文）
  → 返回结果给主 cli
  │
  ▼
主 cli 继续
  → delegate_task("writer", "基于话题写文章")
  → delegate_task("reviewer", "审稿润色")
  → 在群里发最终成品
```

#### 内部 agent 与普通 group 的区别

| | 普通 group | 内部 agent |
|---|---|---|
| 绑定 channel | 是（钉钉/WhatsApp） | 否（纯内部） |
| 触发方式 | 用户发消息 | 主 cli 调 `delegate_task` |
| 结果去向 | 发回聊天群 | 返回给主 cli |
| 持久化 | `groups/{name}/` | `groups/{name}/`（一样） |
| 有记忆/skills | 是 | 是（独立积累） |

#### 改动文件

| 文件 | 改动 |
|------|------|
| `container/extensions/ipc/` | `create_agent` 和 `delegate_task` 工具（主 group 专属，现为 pi extension） |
| `src/ipc.ts` | 处理 `create_agent`（创建目录 + 写 AGENTS.md + 注册）和 `delegate_task`（启动容器 + 写回结果） |
| `src/index.ts` | 实现 `createInternalAgent` 和 `runDelegatedAgent` 回调 |

#### 技术要点

- 内部 agent 使用 `internal:{folder}` 作为 JID，不绑定任何 channel
- `delegate_task` 在容器侧轮询 `ipc/delegates/{requestId}.response.json` 等待结果，5 分钟超时
- 宿主进程异步启动目标容器，完成后写回 response 文件
- 与 sub-agent 的本质区别：持久实体（有记忆、会成长），不是一次性函数调用

### 18. 微信（WeChat）Channel

**日期：** 2026-03-24

#### 设计思路

基于微信新发布的 iLink Bot API（官方腾讯协议），用 HTTP 长轮询收消息。和钉钉 Stream SDK 的 WebSocket 方式不同，iLink 的 `getupdates` 接口 hold 住请求最多 35 秒，通过游标 `get_updates_buf` 增量拉取，本质是服务端推送的长轮询变体。

认证方式也不同于钉钉的 AppKey/AppSecret：微信用 QR 码扫码登录，获取 `bot_token`，之后所有请求 Bearer 认证。每个请求带随机 `X-WECHAT-UIN` 防重放。

#### 与钉钉 Channel 的对比

| | 钉钉 | 微信 |
|---|---|---|
| 协议 | WebSocket（Stream SDK） | HTTP 长轮询（iLink Bot API） |
| 认证 | AppKey + AppSecret → access_token | QR 扫码 → bot_token |
| 连接方式 | SDK 管理 WebSocket 生命周期 | 自管理轮询循环 + 指数退避 |
| 触发模式 | `handlesOwnTrigger = true`（SDK 只推 @机器人 的消息） | `handlesOwnTrigger = false`（收所有群消息，宿主进程判断触发） |
| JID 前缀 | `dt:` | `wx:` |
| 消息长度限制 | 无明显限制 | 2000 字符，自动分段发送 |
| 输入状态 | 不支持 | 支持（`sendtyping` + `typing_ticket`） |
| 凭证存储 | `.env`（AppKey/Secret 永久有效） | `data/weixin-auth.json`（bot_token，可能过期需重新扫码） |
| 启用条件 | `.env` 中有 `DINGDING_APP_KEY` | `WEIXIN_ENABLED=true` 或 `weixin-auth.json` 存在 |

#### 实现要点

- **自注册模式**：和钉钉一样，`registerChannel('weixin', factory)` 在模块加载时注册，缺凭证返回 null 静默跳过
- **QR 码登录**：首次使用调 `get_bot_qrcode` → 轮询 `get_qrcode_status` 等待扫码确认 → 获取 `bot_token` → 存盘
- **长轮询**：`pollMessages()` 循环调 `getupdates`，每次用上一轮返回的游标避免重复收消息，失败时指数退避（1s → 30s）
- **context_token 缓存**：回复消息必须携带入站消息的 `context_token`，按 JID 缓存在内存中
- **401 自动断开**：token 过期时停止轮询并标记 disconnected，需要重新扫码

#### 改动文件

| 文件 | 改动 |
|------|------|
| `src/channels/weixin.ts` | 微信 channel 完整实现（QR 登录、长轮询、消息收发、输入状态） |
| `src/channels/index.ts` | 新增 `import './weixin.js'` 注册微信 channel |

### 19. Evolution Loop 扩展：全局 agent 复盘 → 已被 #20 取代

**日期：** 2026-03-24

> **已过时：** #20 去中心化后，每个 group 独立进化，不再由主 cli 统一复盘。但主 group 仍然挂载了所有 group 的 `conversations/`（只读），这个基础设施保留了，主 cli 需要时可以读取。

原方案设计见下（留作参考）：

<details>
<summary>原方案详情</summary>

原版 evolution loop 只复盘主 cli 自己的对话记录，对内部 agent 的表现一无所知。需要让主 cli 在进化时拥有全局视角。

考虑过三个方案：

1. **每个 group 独立 evolution** — 当时否决（认为内部 agent 缺乏用户反馈信号）→ #20 最终采用了这个方案
2. **delegate_task 让 agent 先自评，主 cli 汇总** — 否决：串行阻塞
3. **主 cli 直接读所有 agent 的对话记录** — 当时采用 → #20 后不再是主要方式

</details>

### 20. Evolution 去中心化

**日期：** 2026-03-27

移除宿主端硬编码的 `ensureEvolutionTask`，evolution 不再由宿主进程注册。改为各 group agent 自己通过 `schedule_task` 注册 evolution 定时任务，由 AGENTS.md 模板引导。新 group 注册时自动复制 AGENTS.md 模板（含自进化指引）。

#### 改动文件

| 文件 | 改动 |
|------|------|
| `src/index.ts` | 移除 `ensureEvolutionTask` 硬编码注册 |
| `container/system-prompt.md` | system prompt 精简为不可变基础（原 pi-agent-runner 代码已删除） |
| `container/templates/AGENTS.md` | 新 group 的 AGENTS.md 模板，含自进化指引 |
| `src/container-runner.ts` | 不覆盖已存在的 skills/extensions，保护 agent 自改 |
