---
name: skill-authoring
description: 创建或修改 group 级 skill。当你需要给自己添加新能力或改进已有 skill 时使用。
---

# 创建 Skill

Skill 是一个目录，包含一个 `SKILL.md` 文件，放在 `/workspace/group/skills/` 下。pi-coding-agent 启动时自动发现并加载。

## 目录结构

```
/workspace/group/skills/
└── my-skill/
    └── SKILL.md
```

## SKILL.md 格式

```markdown
---
name: skill-name
description: 一句话描述这个 skill 做什么，用于 agent 判断何时使用。
---

# Skill 标题

说明这个 skill 的用途和触发场景。

## 流程

具体的步骤说明。可以包含：
- 需要读取哪些文件
- 需要执行哪些命令
- 需要调用哪些工具（web_search、send_message 等）
- 输出格式要求
```

## 关键原则

- **name** 和 **description** 是必须的 frontmatter 字段，agent 靠 description 判断何时触发
- **一个 skill 做一件事**，不要把多个职责塞进一个 skill
- skill 之间可以互相引用（如"先用 workday-check 判断工作日"）
- skill 只是指令文本，不是代码。复杂逻辑用 bash 命令或调用 extension 工具实现
- 文件操作使用 `/workspace/group/` 下的路径，这是你的持久化目录

## 示例

### 简单 skill：每日总结

```markdown
---
name: daily-summary
description: 生成当天工作总结并发送到群里。
---

# 每日总结

1. 读取 `memory/requirements.md`，统计各状态的需求数量
2. 读取 `memory/decisions.md`，找出今天的决策
3. 生成简洁的总结文本，包含需求进展和今日决策
```

### 引用其他 skill 的例子

```markdown
---
name: morning-broadcast
description: 每日早间播报，工作日执行。
---

# 早间播报

1. 先用 workday-check 判断今天是否为工作日，非工作日跳过
2. 执行 daily-summary 生成总结
3. 发送到群里
```
