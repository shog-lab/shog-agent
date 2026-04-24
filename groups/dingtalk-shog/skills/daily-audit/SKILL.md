---
name: daily-audit
description: 每日审核各 group 的改动与运行情况，发现明显错误时回滚或修正。
---

# Daily Audit

审核普通 group 当天的改动与运行情况，防止任务侧改坏、偏航或积累脏状态。

## 前置条件

- 行为回归检查按 `groups/dingtalk-shog/schema/group-evolution-regression.md` 执行（如果该文件存在）
- 当前仓库 git 状态可用于辅助判断哪些文件近期发生了变更

## 输入

- `/workspace/agents/*/AGENTS.md` — 各 group 的人设
- `/workspace/agents/*/skills/` — 各 group 的技能
- `/workspace/agents/*/wiki-config.json` — 各 group 的检索参数
- `/workspace/group/raw/mailbox/inbox/` — meta-agent 收到的治理上报
- `/workspace/agents/*/raw/logs/` — 关键运行日志
- `/workspace/agents/*/raw/conversations/` — 对话审计记录（如可用）
- `git diff --name-only` / `git status --short` — 当前仓库改动线索

## 流程

### 1. 扫描近期改动与运行痕迹

对每个 group，检查：

```bash
git status --short
git diff --name-only
find /workspace/group/raw/mailbox/inbox -type f 2>/dev/null
find /workspace/agents/{group}/raw/logs -type f | tail
```

重点关注：
- skills 是否出现明显错误改写
- AGENTS.md 是否偏离当前治理原则
- wiki-config 是否出现异常参数
- 是否有重复出现的治理上报、错误日志或失败模式

### 2. 评估问题

判断哪些属于：
- **合理改动**：符合当前治理策略与任务需要
- **不合理改动**：引入错误、复杂度失控、偏离角色边界、缺乏依据
- **需要继续观察**：证据不足，先记录不立即处理

### 3. 处理明显问题

发现明显错误时：
- 优先做最小修正
- 如需回滚，直接基于 git 或当前已知正确内容恢复
- 不依赖 checkpoint 目录

### 4. 记录

写一条审核记录到 wiki：

```markdown
---
date: <ISO>
type: note
tags: [daily-audit]
---

## Daily Audit

- 检查了哪些 group
- 发现了哪些异常或趋势
- 做了哪些修正 / 回滚
- 哪些问题暂缓观察
```
