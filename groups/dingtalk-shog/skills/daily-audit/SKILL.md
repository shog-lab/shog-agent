---
name: daily-audit
description: 每日审查各 group 运行情况 + 检查 follow-up 观察结果，报告给人。
---

# Daily Audit

审核普通 group 当天的改动与运行情况，检查 follow-up 观察状态，报告给人。

## 前置条件

- 行为回归检查按 `groups/dingtalk-shog/schema/group-evolution-regression.md` 执行（如果该文件存在）
- 当前仓库 git 状态可用于辅助判断哪些文件近期发生了变更

## 输入

- `/workspace/agents/*/AGENTS.md` — 各 group 的人设
- `/workspace/agents/*/skills/` — 各 group 的技能
- `/workspace/agents/*/wiki-config.json` — 各 group 的检索参数
- `/workspace/group/wiki/` — wiki 条目（包含 follow-up）
- `/workspace/group/raw/mailbox/inbox/` — 可选升级上报留痕（如有）
- `/workspace/agents/*/raw/logs/` — 关键运行日志
- `git diff --name-only` / `git status --short` — 当前仓库改动线索

## 流程

### 1) 扫描近期改动与运行痕迹

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
- 是否有重复出现的升级上报、错误日志或失败模式

### 2) 检查 follow-up 观察状态

扫描 `/workspace/group/wiki/` 中所有带 `follow-up` tag 的条目：

```bash
grep -rl "^tags:.*follow-up" /workspace/group/wiki/ 2>/dev/null
```

对每个 follow-up 条目：
- 读取 `观察期` 和 `验证标准`
- 判断是否已到期（日期 >= date + followUpDays）
- 判断验证记录是否已满足（3 次交互勾选完成）
- 评估效果：
  - **有效**：后续无同类问题
  - **复发**：同类问题再次出现
  - **需继续观察**：证据仍不充分

### 3) 评估问题（只报不修）

判断哪些属于：
- **合理改动**：符合当前角色职责与任务需要
- **不合理改动**：引入错误、复杂度失控、越过平台边界、缺乏依据
- **需要继续观察**：证据不足，先记录不立即处理

**Meta-agent 不自行修复任何问题**。只报告给人，由人触发修改。

### 4) 报告给人

通过 `send_message` 发送钉钉报告：

```
## Daily Audit 报告

### Follow-up 观察结果
- <follow-up 条目标题> → <有效/复发/需继续观察>
- ...

### 异常检测
- <group>: <问题描述>
- ...

### 建议
- 需要人介入处理的事项
```

### 5) 记录观察结论

对每个已到期/已满足的 follow-up，写一条观察记录到 wiki：

```markdown
---
date: <ISO>
type: note
tags: [meta-observation]
source: daily-audit
summary: "<follow-up 主题> 观察结论：<有效/复发>"
---

## 观察结论

- **主题**：<topic>
- **类型**：<认知/行为/偏好>
- **观察期**：<N 天>
- **验证记录**：<交互 1/2/3 结果>
- **结论**：<有效/复发/需继续观察>
- **建议**：<下一步建议>
```

### 6) 写审核记录

```markdown
---
date: <ISO>
type: note
tags: [daily-audit]
---

## Daily Audit

- 检查了哪些 group
- 发现了哪些异常或趋势
- follow-up 观察状态摘要
- 需要人介入处理的事项
```
