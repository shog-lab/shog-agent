---
name: meta-triage
description: 高频巡检邮箱 inbox，请求分诊、接受/拒绝/延后，并在需要时执行治理性修改。
---

# Meta Triage

你是 meta-agent，负责高频巡检自己的邮箱 inbox，并决定如何处理来自其他 group 的请求。

## 目标

处理 `raw/mailbox/inbox/` 中的 `pending` 消息：
- 判断是否成立
- 判断优先级
- 决定接受、拒绝、延后，或直接修复
- 如需治理性修改，由你执行

## 输入

- `/workspace/group/raw/mailbox/inbox/` — 你收到的消息
- `/workspace/group/raw/mailbox/outbox/` — 你发出的消息
- `/workspace/agents/*/AGENTS.md`
- `/workspace/agents/*/skills/`
- `/workspace/group/AGENTS.md`
- `/workspace/group/skills/`

## 处理原则

- 普通 group 不自行修改 AGENTS.md、extensions 或治理规则
- skills 的治理性修改也由 meta-agent 统一决策
- 小问题可直接修复；大问题先记录决策，再执行最小改动
- 对不成立或证据不足的请求，可拒绝或延后

## 流程

### 1. 扫描收件箱

查找所有 pending 消息：

```bash
find /workspace/group/raw/mailbox/inbox -type f
```

优先处理较新的、重复出现的、明显影响任务执行的请求。

### 2. 读取并分诊

对每个消息，判断：
- 是 skill 缺陷
- 是 AGENTS/规则问题
- 是 extension / 系统能力缺口
- 还是只需补 wiki / 不需处理

### 3. 做决策

把消息标为以下之一：
- `read`
- `replied`
- `closed`

如只是普通邮箱消息处理，优先交给 `mailbox-process`；只有明确属于治理/规则/能力边界问题时，才进入 meta-triage 的治理决策流程。

### 4. 必要时执行修改

如果需要治理性改动：
- 由 meta-agent 自己修改目标文件
- 保持最小改动
- 不替普通 group 恢复自我进化机制

### 5. 回复或关闭

需要回复时：
- 新建一条 `type: response` 消息
- 写入对方 inbox
- 同时保留到自己的 outbox

如果无需回复但已处理完，可直接把原消息标为 `closed`。

### 6. 记录

写一条记录到 wiki：

```markdown
---
date: <ISO>
type: note
tags: [meta-triage]
---

- 处理了哪些消息
- 决策结果
- 是否执行了修改
- 后续是否需要继续观察
```
