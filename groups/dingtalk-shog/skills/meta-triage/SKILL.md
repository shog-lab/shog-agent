---
name: meta-triage
description: 高频巡检治理上报 inbox，请求分诊、接受/拒绝/延后，并在需要时执行治理性修改。
---

# Meta Triage

你是 meta-agent，负责高频巡检自己的治理上报 inbox，并决定如何处理来自其他 group 的请求。

## 目标

处理 `raw/mailbox/inbox/` 中的 `pending` 治理请求：
- 判断是否成立
- 判断优先级
- 决定接受、拒绝、延后，或直接修复
- 如需治理性修改，由你执行

## 输入

- `/workspace/group/raw/mailbox/inbox/` — 你收到的治理上报
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

### 1. 扫描治理上报

查找所有 pending 请求：

```bash
find /workspace/group/raw/mailbox/inbox -type f
```

优先处理较新的、重复出现的、明显影响任务执行的请求。

### 2. 读取并分诊

对每个请求，判断：
- 是 skill 缺陷
- 是 AGENTS/规则问题
- 是 extension / 系统能力缺口
- 还是只需补 wiki / 不需处理

### 3. 做决策

把请求标为以下之一：
- `accepted`
- `rejected`
- `deferred`
- `fixed`

这是治理上报通道，不需要实现通用 agent 间回信流程；重点是分诊、决策和必要的治理修改。

### 4. 必要时执行修改

如果需要治理性改动：
- 由 meta-agent 自己修改目标文件
- 保持最小改动
- 不替普通 group 恢复自我进化机制

### 5. 回写结果

更新请求处理结论，并补充必要备注。

同时写一条记录到 wiki：

```markdown
---
date: <ISO>
type: note
tags: [meta-triage]
---

- 处理了哪些治理请求
- 决策结果
- 是否执行了修改
- 后续是否需要继续观察
```
