---
name: feedback-handler
description: 处理用户反馈信号，触发信念更新或行为纠正，写入 follow-up 跟踪。
---

# Feedback Handler

当用户发出负面反馈时（纠正、质疑、抱怨），自动调用本 skill 处理。

## 触发条件

收到用户反馈后，判断是否包含以下信号，有任意一条即触发：

- **纠正信号**：`不对`、`不是这样`、`你说错了`、`应该是`、`之前说的不对`
- **质疑信号**：`你确定吗？`、`真的吗？`、`不对吧`
- **抱怨信号**：`太差了`、`根本不行`、`完全错了`
- **偏好信号**：`我觉得应该`、`我更喜欢`、`不如改成`
- **Agent 承认错误**：`抱歉我搞错了`、`我收回刚才说的`

## 流程

### 1. 分类反馈

判断类型：

```
A) 认知纠正 — 用户的结论/事实/判断与 agent 不同
B) 行为纠正 — 用户的操作方式/代码/配置与 agent 不同
C) 偏好表达 — 用户表达个人偏好，没有绝对对错
```

### 2. 写新 wiki 条目

写入 `/workspace/group/wiki/`：

```markdown
---
date: <ISO>
type: <type>  #认知用 fact，行为用 workflow，偏好用 preference
tags: [<topic>, corrected]
source: user-feedback:<user-message-id>
summary: <50字概括>
---

## 纠正内容

- **用户纠正**：<用户原话摘要>
- **旧结论**：<agent 之前的说法>
- **新结论**：<用户更正后的结论>

## 相关上下文

<相关对话片段>
```

### 3. 标记旧条目

如果 wiki 中有与新结论冲突的旧条目，在该条目 frontmatter 添加：

```yaml
superseded-by: <新文件名的slug>
tags: [..., superseded]
```

### 4. 写 follow-up 条目

写入 `/workspace/group/wiki/`：

```markdown
---
date: <ISO>
type: note
tags: [follow-up, belief-update]
source: observation
summary: 观察 "<topic>" 是否在后续生效
---

## 观察任务

- **纠正类型**：<A/B/C>
- **主题**：<topic>
- **新结论**：<新结论简述>
- **观察期**：7 天（可调整 via wiki-config.json）
- **验证标准**：后续 3 次相关交互中用户不再纠正 / 任务执行成功

## 验证记录

- [ ] 交互 1：
- [ ] 交互 2：
- [ ] 交互 3：

## 结论

- 有效 / 需继续观察 / 已复发
```

### 5. 行为纠正特殊处理

如果类型是 B（行为纠正），额外：

- 检查是否需要更新 `skills/` 或 `AGENTS.md`
- 如果需要，提示人："建议修改 XXX"，不自行修改

### 6. 记录维护

写完 follow-up 后，在同一目录下追加到维护日志：

```markdown
- <ISO> 处理反馈：<类型> - <主题> - 写 follow-up
```

## 配置

观察期默认 7 天，可在 `wiki-config.json` 中调整：

```json
{
  "feedback": {
    "followUpDays": 7
  }
}
```

## 注意事项

- 不要在 skill 执行过程中调用其他 skill
- 写 wiki 时使用原子操作（先写临时文件再 rename）
- 如果同类反馈已有 open 状态的 follow-up，不重复写，追加到已有条目
