# 自进化体系

## 概述

主 group（dingtalk-shog）负责所有 agent 的进化管理。两层循环：每日整理，每周评估+决策。

核心原则：**指标驱动，退步即回滚。**

## 两层循环

### 每日复盘（daily-review）

**触发**：定时任务，每天 22:00

**执行者**：主 group L1

**输入**：
- 所有 group 的对话记录（`/workspace/agents/*/conversations/`）
- 所有 group 的 wiki 记忆
- 所有 group 的 skills 列表和 AGENTS.md

**动作**：
1. 扫描每个 group 最近 24 小时的对话
2. 识别：成功模式、失败模式、用户不满、能力缺口
3. 产出一条日报，写入主 group 的 wiki（type: note，tag: daily-review）
4. 如果发现明确的问题且修复方案清晰，可以直接改目标 group 的 AGENTS.md 或 skills

**不做**：不跑指标，不做回滚判断。日常小修小补，快速迭代。

### 每周复盘（weekly-review）

**触发**：定时任务，每周日 21:00

**执行者**：主 group L1（需要时启动 L2）

**输入**：
- 本周的所有日报（wiki 里 tag: daily-review 的条目）
- 上周的 checkpoint 指标
- 当前各 group 的 AGENTS.md、skills、wiki-config.json

**动作**：
1. 回顾本周日报，总结改动和趋势
2. 跑指标（见下方"指标体系"）
3. 对比上周 checkpoint 的指标
4. **进步**：归档当前状态为新的 checkpoint（覆盖旧 checkpoint）
5. **退步**：从 checkpoint 恢复，回滚本周的改动
6. 产出周报，写入主 group 的 wiki（type: note，tag: weekly-review）

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
| **对话满意度** | 用户不满计数（对话中识别） | 每日复盘时从对话记录提取 |
| **任务成功率** | 对话中完成/失败比例 | 每日复盘时统计 |
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

当前已有的 evolution skills：

| Skill | 现状 | 调整 |
|-------|------|------|
| `daily-review` | 扫描对话和 task-logs，改 harness | 保留，移除 task-logs 相关逻辑（已删），加入日报产出 |
| `autoresearch-loop` | 每周做检索质量实验 | 并入 weekly-review 的指标跑分环节 |
| `wiki-lint` | 每周检查 wiki 质量 | 保留，可作为 daily-review 的子步骤 |

## 实施顺序

1. 改造 `daily-review` skill：加入日报产出逻辑
2. 创建 `weekly-review` skill：指标对比 + checkpoint 归档/回滚
3. 创建 checkpoint 目录结构
4. 将 `autoresearch-loop` 的指标逻辑并入 weekly-review
5. 注册定时任务（daily 22:00，weekly 周日 21:00）
