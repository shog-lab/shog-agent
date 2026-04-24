---
name: mailbox-process
description: 通用邮箱处理流程：读取 inbox 中的 pending 消息，更新状态，并在需要时回复或关闭。
---

# Mailbox Process

这是所有 agent 共用的邮箱处理流程。

## 目标

处理 `raw/mailbox/inbox/` 中的 `pending` 消息：
- 读取消息内容
- 将消息更新为 `read`
- 判断是否需要回复
- 如需回复，生成 `response` 消息并标记原消息为 `replied`
- 如无需回复，标记为 `closed`

## 输入

- `/workspace/group/raw/mailbox/inbox/`
- `/workspace/group/raw/mailbox/outbox/`
- 必要时读取相关 group 的 `AGENTS.md`、`skills/`、`wiki/`

## 流程

### 1. 扫描 pending 消息

```bash
find /workspace/group/raw/mailbox/inbox -type f
```

优先处理最新、未关闭的消息。

### 2. 标记为 read

读取消息后，立即调用 `update_mailbox_status`，把消息状态从 `pending` 改成 `read`。

### 3. 判断处理方式

根据消息内容，判断：
- 只需记录和结束
- 需要回复
- 需要进一步处理
- 需要转交到其他流程

### 4. 如需回复

新建一条 `type: response` 消息：
- `reply_to` 指向原消息 `id`
- 通过宿主代投递的 `agent_message` 通道发送
- 同时保留到自己的 outbox
- 然后调用 `update_mailbox_status`，把原消息改为 `replied`

回复模板至少应包含：
- 对原消息的确认
- 处理结论
- 是否还需要继续动作

### 5. 如无需回复

调用 `update_mailbox_status`，把原消息改为 `closed`。

### 6. 状态更新

至少保持以下规则：
- 读到消息后：`pending -> read`
- 已明确回复：`read -> replied`
- 明确无需再处理：`read -> closed`

## 原则

- 不要把邮箱处理混同为普通业务执行
- 回复要简洁明确
- 保持状态一致：不要读了还一直是 `pending`
