# Agent Communication Model

## 概述

ShogAgent 的 agent 间通信采用统一的**邮箱模型（mailbox model）**。

设计目标：
- **统一**：meta-agent 与普通 group 使用同一套通信机制
- **异步**：不要求实时在线或同步往返
- **通用**：先不按场景拆分，任务委托、治理请求、状态汇报、普通问答都走同一模型
- **可审计**：消息是文件，天然可追踪、可回顾

## 目录结构

每个 group 在自己的 `raw/` 下维护邮箱目录：

```txt
raw/
  mailbox/
    inbox/
    outbox/
```

说明：
- `inbox/`：收到的消息
- `outbox/`：自己发出的消息副本

## 消息格式

一条消息对应一个 Markdown 文件。

示例：

```md
---
id: msg-2026-04-23-001
from: dingtalk-harness
to: dingtalk-shog
type: request
status: pending
created_at: 2026-04-23T12:00:00Z
reply_to:
subject: skill 调整建议
---

在 yt-dubbing 巡检中发现当前 skill 缺少一个边界条件，建议 meta-agent 评估是否需要调整。
```

### 最小字段

- `id`：消息唯一标识
- `from`：发送方 group
- `to`：接收方 group
- `type`：消息类型
- `status`：当前状态
- `created_at`：创建时间（ISO）
- `reply_to`：回复链路（可空）
- `subject`：主题（可空但建议有）

正文部分为 `content`。

## 建议的 type

第一版保持尽量少：

- `message`：普通消息
- `request`：请求 / 求助 / 提议
- `response`：回复
- `event`：状态更新 / 结果通知

以后如有必要，再扩展更细的类型。

## 状态流转

第一版统一使用：

- `pending`：待处理
- `read`：已读
- `replied`：已回复
- `closed`：已关闭

说明：
- `pending` → `read`：接收方已查看
- `read` → `replied`：接收方已回复
- `read` / `replied` → `closed`：该通信线程结束

## 基本规则

### 发信

发送方应：
1. 生成消息文件
2. 写入目标 group 的 `raw/mailbox/inbox/`
3. 同时在自己的 `raw/mailbox/outbox/` 保留副本

### 收信

接收方应：
1. 扫描自己的 `raw/mailbox/inbox/`
2. 优先处理 `pending` 状态消息
3. 先更新为 `read`
4. 再决定回复、关闭或转入其他治理流程

### 回复

回复不是修改原消息正文，而是：
1. 新建一条新消息
2. `type: response`
3. `reply_to` 指向原消息 `id`
4. 原消息状态改为 `replied`

### 关闭

当通信已完成、无需继续往返时，可将线程相关消息状态标为 `closed`。

## 当前实现进度

当前已经实现：
- 普通 group 通过宿主 IPC 提交 `agent_message`
- 宿主代投递到目标 inbox / 发送方 outbox
- 目标 group 活跃时立即发送 mailbox 处理 prompt
- 目标 group 不活跃时创建一次性 task 唤起处理

当前尚未完全自动化：
- `read / replied / closed` 的自动状态回写
- 任意 group ↔ 任意 group 的全量通用化

## 与 meta-agent 的关系

meta-agent 不使用特殊通信通道。

它和普通 group 一样：
- 有 inbox
- 有 outbox
- 发收同一种消息文件

区别只在于：
- meta-agent 拥有更高治理权限
- meta-agent 可以处理治理性请求
- meta-agent 可以根据消息内容决定是否修改 skills、AGENTS.md、extensions 或系统配置

## 与当前 meta-request 的关系

当前 `raw/meta-requests/` 可以视为旧的特化治理上报机制。

后续应逐步收敛到统一邮箱模型：
- 治理请求也变成 mailbox 中的一类消息
- 不再单独维护一套“病例专线”

推荐映射：
- 病例 / 治理请求 → `type: request`
- meta-agent 回执 → `type: response`
- 处理中 / 已修复通知 → `type: event`

## 适用范围

这套模型可覆盖：
- 普通问答协作
- 任务委托
- 状态汇报
- 治理请求
- 结果回复

但第一版先保持简单，不引入：
- 实时会话
- 广播
- 多播
- 优先级调度
- 自动路由

## 后续演进方向

如果邮箱模型跑顺了，后续再考虑：
- 增加优先级字段
- 增加附件/引用能力
- 增加线程视图
- 增加定时轮询与提醒机制
- 把 meta-triage 建立在 mailbox 之上，而不是依赖单独目录

## 当前建议

先把 mailbox 当成 **ShogAgent 统一的 agent-to-agent 通信基础设施**。

不要先按场景拆协议；先让所有 agent 都会“收信、发信、回信”。
