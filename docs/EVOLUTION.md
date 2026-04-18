# 自进化体系

## 概述

两层进化机制：子 group 实时自优化，主 group 每日审核 + 每周评估兜底。

核心原则：**子 group 自治，主 group 治理；指标驱动，退步即回滚。**

## 子 group 自优化（实时）

每个 group 在每次对话结束后自动评估是否需要优化，不需要主 group 介入。

### 机制：Meta-skill + Hook

两个组件配合：

**1. Meta-skill（`container/skills/self-improve/SKILL.md`）**

所有 group 共享的内建 skill，定义自优化的 SOP：

- **什么时机该优化**：skill 执行失败、用户纠正了错误行为、发现可复用的经验模式、相同问题反复出现
- **优化什么**：
  - 修 `skills/` 下的 SKILL.md（步骤错误、信息过时、缺少边界条件）
  - 写 wiki（新发现的领域知识、用户偏好、项目约定）
- **什么不能碰**：
  - 不改 AGENTS.md（人设变更由主 group 管理）
  - 不改内建 skills（`/app/skills/`，只读）
  - 不改 extensions
- **怎么改**：最小改动，只改有明确证据支持的部分，不做推测性优化

**2. Hook extension（`container/extensions/self-improve/`）**

pi extension，监听 `agent_end` 事件。每次对话结束后：

1. 用 LLM 分析本次对话，判断是否存在优化信号：
   - 用户纠正了 agent 的错误
   - 任务失败或重试
   - 用户明确要求记住某事
   - skill 执行中遇到意外情况
2. **无信号**：跳过，不产生额外开销
3. **有信号**：通过 RPC stdin 发送新的 `prompt`，让 agent 立即按 self-improve skill 执行优化（不等下一轮对话）

信号检测用 LLM 判断而非关键词匹配，确保准确度。成本问题后续可通过模型路由解决（信号检测用轻量模型，实际优化用主力模型）。

### 范围

只改自己的 skills 和 wiki。AGENTS.md 的变更由主 group 统一管理。

## 主 group 复盘

### 每日审核（daily-audit）

**触发**：定时任务，每天 22:00

**执行者**：主 group L1

**目的**：审核子 group 当天的自优化改动，防止改坏。

**动作**：
1. 扫描各 group 当天的 skills 和 wiki 变更（对比 checkpoint）
2. 用 LLM 评估每个改动是否合理
3. 发现明显错误的改动：回滚该文件（文件级粒度，不影响其他改动）
4. 产出审核记录，写入主 group 的 wiki（type: note，tag: daily-audit）

**不做**：不跑 benchmark，不做全局指标对比。只审核改动质量。

### 每周复盘（weekly-review）

**触发**：定时任务，每周日 21:00

**执行者**：主 group L1（需要时启动 L2）

**输入**：
- 所有 group 本周的对话记录（`/workspace/agents/*/conversations/`）
- 本周的 daily-audit 记录
- 上周的 checkpoint 指标
- 当前各 group 的 AGENTS.md、skills、wiki-config.json

**动作**：
1. 回顾本周 daily-audit 记录，总结改动趋势
2. 跑指标（见下方"指标体系"）
3. 对比上周 checkpoint 的指标
4. **进步**：归档当前状态为新的 checkpoint（覆盖旧 checkpoint）
5. **退步**：逐文件对比，只回滚退步相关的文件，保留有效改动
6. 调用 wiki-lint skill 检查各 group wiki 质量（去重、过期、断链）
7. 产出周报，写入主 group 的 wiki（type: note，tag: weekly-review）
8. 如有需要，修改目标 group 的 AGENTS.md

## 三层的分工

| | 子 group（自优化） | 主 group（daily-audit） | 主 group（weekly-review） |
|---|---|---|---|
| **做什么** | 改自己的 skills、wiki | 审核子 group 改动质量 | 全局指标评估 + 回滚/归档 |
| **触发** | agent_end hook | 每天 22:00 | 每周日 21:00 |
| **依据** | 本次对话反馈 | 对比 checkpoint 的 diff | 跨 group 指标对比 |
| **回滚** | 不回滚 | 文件级回滚（改坏的单个文件） | 文件级回滚（指标退步相关文件） |
| **视角** | 单 group 领域知识 | 改动质量把控 | 全局治理 |

## Checkpoint 机制

### 归档范围

每个 group 的以下文件：

| 文件 | 说明 |
|------|------|
| `AGENTS.md` | agent 人设和行为规范 |
| `skills/` | 技能定义 |
| `wiki-config.json` | 检索参数（阈值、权重、embedding 模型等） |

**不归档**：wiki 内容（知识是增量的，不回退）、conversations、session 数据。

### 存储位置

```
groups/dingtalk-shog/checkpoints/
├── latest/                          ← 当前最优实现（文件级独立管理）
│   ├── dingtalk-shog/
│   │   ├── AGENTS.md
│   │   ├── skills/
│   │   │   ├── skill-a/SKILL.md
│   │   │   └── skill-b/SKILL.md
│   │   └── wiki-config.json
│   ├── dingtalk-harness/
│   │   └── ...
│   └── metrics.json                 ← 上次归档时的指标快照
└── history/                         ← 历史快照（可选，按日期）
    └── 2026-04-20/
        └── ...
```

### 归档操作（weekly-review，指标进步时）

```bash
cp -r /workspace/agents/{group}/AGENTS.md checkpoints/latest/{group}/
cp -r /workspace/agents/{group}/skills/ checkpoints/latest/{group}/
cp -r /workspace/agents/{group}/wiki-config.json checkpoints/latest/{group}/
```

### 回滚操作（文件级粒度）

```bash
# daily-audit 或 weekly-review 发现某个文件有问题，只回滚该文件
cp checkpoints/latest/{group}/skills/bad-skill/SKILL.md /workspace/agents/{group}/skills/bad-skill/
# 其他文件不动
```

## 指标体系

> 具体指标待定，以下为候选方向。

### 候选指标

| 指标 | 测量方式 | 说明 |
|------|---------|------|
| **检索质量** | LongMemEval benchmark | 当前 77.4%，跑子集验证 |
| **对话满意度** | 用户不满计数（对话中识别） | 从对话记录提取 |
| **任务成功率** | 对话中完成/失败比例 | 从对话记录统计 |
| **技能使用率** | skill 被调用次数 | 从对话记录提取 |
| **响应质量** | 用户追问/纠正次数 | 追问多说明首次回答不够好 |

### 指标存储

每次 weekly-review 归档时，写入 checkpoint：

```
groups/dingtalk-shog/checkpoints/latest/metrics.json
```

```json
{
  "date": "2026-04-20",
  "longmemeval": 0.774,
  "satisfaction": 0.85,
  "task_success_rate": 0.92,
  "details": { ... }
}
```

## 与现有 skill 的关系

| Skill | 现状 | 调整 |
|-------|------|------|
| `daily-review` | 扫描对话和 task-logs，改 harness | 改造为 daily-audit（审核子 group 改动质量） |
| `autoresearch-loop` | 每周做检索质量实验 | 废弃 |
| `wiki-lint` | 每周检查 wiki 质量 | 保留，由 weekly-review 内部调用 |

## 实施顺序

1. 创建 `container/skills/self-improve/SKILL.md`（meta-skill，所有 group 共享）
2. 创建 `container/extensions/self-improve/`（hook extension，监听 agent_end，通过 RPC stdin 触发优化）
3. 删除 system-prompt.md 中的 `Runtime self-improvement` 段落
4. 改造 `daily-review` skill 为 `daily-audit`（审核改动质量，文件级回滚）
5. 创建 `weekly-review` skill（指标对比 + checkpoint 归档/回滚 + 调用 wiki-lint）
6. 创建 checkpoint 目录结构
7. 注册定时任务（daily-audit 22:00，weekly-review 周日 21:00）
8. 废弃 `autoresearch-loop` skill 及定时任务
