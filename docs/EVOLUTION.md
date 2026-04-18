# 自进化体系

## 概述

两层进化机制：子 group 实时自优化，主 group 每周评估兜底。

核心原则：**子 group 自治，主 group 治理；指标驱动，退步即回滚。**

## 子 group 自优化（实时）

每个 group 在执行任务过程中自行优化，不需要主 group 介入。

**触发**：实时——执行任务时发现问题就改

**机制**：system prompt 中的 `Runtime self-improvement` 指令，让 agent 发现 skill 不好用时当场修 SKILL.md、发现可复用经验时写 wiki。

**范围**：只改自己的 skills 和 wiki，不改 AGENTS.md（人设变更由主 group 管理）。

**不需要额外 skill**——这是 agent 的内建行为。

## 主 group 每周复盘（weekly-review）

**触发**：定时任务，每周日 21:00

**执行者**：主 group L1（需要时启动 L2）

**输入**：
- 所有 group 本周的对话记录（`/workspace/agents/*/conversations/`）
- 上周的 checkpoint 指标
- 当前各 group 的 AGENTS.md、skills、wiki-config.json

**动作**：
1. 扫描所有 group 本周对话，识别：成功模式、失败模式、用户不满、能力缺口
2. 跑指标（见下方"指标体系"）
3. 对比上周 checkpoint 的指标
4. **进步**：归档当前状态为新的 checkpoint（覆盖旧 checkpoint）
5. **退步**：从 checkpoint 恢复，回滚本周的改动
6. 产出周报，写入主 group 的 wiki（type: note，tag: weekly-review）
7. 如有需要，修改目标 group 的 AGENTS.md 或 skills

## 两层的分工

| | 子 group（自优化） | 主 group（weekly-review） |
|---|---|---|
| **改什么** | 自己的 skills、wiki | 任何 group 的 AGENTS.md、skills |
| **触发** | 实时（执行中发现问题就改） | 定时（每周日） |
| **依据** | 自己的执行经验 | 跨 group 的数据对比 |
| **回滚** | 不回滚（小改动，错了下次改回来） | 指标驱动回滚（checkpoint 机制） |
| **视角** | 单 group 领域知识 | 全局治理和兜底 |

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
├── latest/                          ← 当前最优实现
│   ├── dingtalk-shog/
│   │   ├── AGENTS.md
│   │   ├── skills/
│   │   └── wiki-config.json
│   ├── dingtalk-harness/
│   │   ├── AGENTS.md
│   │   ├── skills/
│   │   └── wiki-config.json
│   └── ...
└── history/                         ← 历史快照（可选，按日期）
    └── 2026-04-20/
        └── ...
```

### 归档操作

```bash
# 由 L1 在 weekly-review 中执行
cp -r /workspace/agents/{group}/AGENTS.md checkpoints/latest/{group}/
cp -r /workspace/agents/{group}/skills/ checkpoints/latest/{group}/
cp -r /workspace/agents/{group}/wiki-config.json checkpoints/latest/{group}/
```

### 回滚操作

```bash
# 由 L1 在 weekly-review 中执行（指标退步时）
cp checkpoints/latest/{group}/AGENTS.md /workspace/agents/{group}/
cp -r checkpoints/latest/{group}/skills/ /workspace/agents/{group}/
cp checkpoints/latest/{group}/wiki-config.json /workspace/agents/{group}/
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

每次 weekly-review 跑完指标后，写入 checkpoint：

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
| `daily-review` | 扫描对话和 task-logs，改 harness | 废弃，子 group 实时自优化替代 |
| `autoresearch-loop` | 每周做检索质量实验 | 废弃，价值不高 |
| `wiki-lint` | 每周检查 wiki 质量 | 保留，可作为 weekly-review 的子步骤 |

## 实施顺序

1. 创建 `weekly-review` skill：扫描对话 + 指标对比 + checkpoint 归档/回滚
2. 创建 checkpoint 目录结构
3. 注册定时任务（每周日 21:00）
4. 各 group AGENTS.md 强调 Runtime self-improvement 行为
5. 废弃 `daily-review` 和 `autoresearch-loop` skill 及定时任务
