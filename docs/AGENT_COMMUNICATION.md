# Governance Reporting Channel

## 概述

当前主分支只保留一个**极简治理上报通道**，而不是完整多 agent 通信系统。

设计目标：
- **单向优先**：普通 group 向 meta-agent 上报治理请求
- **宿主代投递**：普通 group 不直接写 meta-agent 目录
- **异步处理**：meta-agent 活跃时立即处理，不活跃时由宿主创建一次性任务唤起
- **可扩展**：消息文件格式与宿主投递逻辑保留未来扩展成完整 agent communication 的可能

## 当前范围

当前只保证这条链路：

- 普通 group → meta-agent（`dingtalk-shog`）

当前**不承诺**：
- 任意 group ↔ 任意 group 通信
- 通用 mailbox 回复机制
- 完整消息状态机
- 通用 mailbox skill / 通用消息消费框架

## 实现方式

### 1. 普通 group 发起治理上报

普通 group 在容器内发现需要治理侧处理的问题时，向自己的 IPC `tasks/` 写入一条请求：

```json
{
  "type": "agent_message",
  "from": "dingtalk-harness",
  "to": "dingtalk-shog",
  "subject": "governance signal report",
  "content": "..."
}
```

### 2. 宿主代投递

宿主收到后，将请求写入 meta-agent 的：

```txt
groups/dingtalk-shog/raw/mailbox/inbox/
```

消息文件示例：

```md
---
id: msg-2026-04-23-001
from: dingtalk-harness
to: dingtalk-shog
type: request
status: pending
created_at: 2026-04-23T12:00:00Z
subject: governance signal report
---

检测到本次对话/执行中存在需要治理侧评估的信号。
```

### 3. 宿主唤起 meta-agent 处理

- 如果 meta-agent 当前活跃：直接发送 follow-up prompt
- 如果 meta-agent 当前不活跃：创建一次性 task 唤起处理

## 为什么仍保留 mailbox 目录

虽然当前只做治理上报通道，但仍然使用：

```txt
raw/mailbox/inbox/
```

原因是：
- 便于审计和人工检查
- 与未来完整 mailbox 模型兼容
- 不需要未来再迁移目录结构

## 后续扩展接口

当前实现有意保留以下扩展位：

- IPC 类型名继续使用 `agent_message`
- 消息 frontmatter 保留 `id / from / to / type / status / created_at / subject`
- 宿主投递逻辑独立存在，可扩展到更多目标 group

这意味着未来如果要恢复完整多 agent 通信，可以在此基础上继续扩展，而不是推翻重来。
