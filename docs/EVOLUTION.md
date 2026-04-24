# 自进化体系

## 概述

自进化与治理相关的 meta-skill 只属于 meta-agent。普通 group 不再自行运行 self-improve / evolution 类机制。

核心原则：**普通 group 专注任务执行，meta-agent 负责治理、审核、分工与进化。**

## 普通 group

普通 group 不使用 meta-skill，不进行实时自优化。

允许的持续改动范围：
- 执行任务时写业务 wiki
- 在既有职责内使用已有 skills

不再允许的机制：
- `self-improve`
- `evolution`
- 对自身 skills 的自动改写
- 对自身 AGENTS.md / extensions 的自行修改

如果普通 group 发现：
- skill 有缺陷
- 规则需要调整
- 需要新增能力

应通过治理上报通道把问题上报给 meta-agent，由 meta-agent 决定是否修改 skills、AGENTS.md、extensions 或系统配置。

## meta-agent

### 每日审核（daily-audit）

**触发**：定时任务，每天 22:00

**执行者**：meta-agent L1

**目的**：审核普通 group 的近期改动与运行情况，防止任务侧改坏、偏航或积累脏状态。

**动作**：
1. 扫描各 group 当天的 skills / wiki / 关键运行痕迹变更（对比 checkpoint）
2. 用 LLM 评估每个改动是否合理
3. 发现明显错误的改动：回滚该文件（文件级粒度，不影响其他改动）
4. 产出审核记录，写入 meta-agent 的 wiki（type: note，tag: daily-audit）

**不做**：不跑 benchmark，不做全局指标对比。只审核改动质量与运行稳定性。

## 分工

| | 普通 group | meta-agent（meta-triage） | meta-agent（daily-audit） |
|---|---|---|---|
| **做什么** | 执行业务任务，沉淀 wiki | 高频分诊病例与治理请求 | 审核普通 group 改动质量 |
| **触发** | 用户任务 / 定时任务 | 高频 interval 任务 | 每天 22:00 |
| **依据** | 当前任务上下文 | raw/mailbox/inbox 中的治理上报与最近上下文 | 对比 checkpoint 的 diff |
| **回滚** | 不自行回滚治理配置 | 仅在必要时执行治理性修改 | 文件级回滚（改坏的单个文件） |
| **视角** | 单 group 任务执行 | 高频治理分诊 | 改动质量把控 |

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

如后续恢复周度复盘，可再把指标写入 checkpoint：

```
groups/dingtalk-shog/checkpoints/latest/metrics.json
```

## 与现有 skill 的关系

| Skill | 现状 | 调整 |
|-------|------|------|
| `daily-review` | 扫描对话和 task-logs，改 harness | 改造为 daily-audit（仅 meta-agent 使用） |
| `self-improve` | 普通 group 实时自优化 | 废弃，不再给普通 group 使用 |
| `weekly-review` | 周度全局复盘 | 暂时移除，后续需要时再恢复 |
| `wiki-lint` | wiki 质量检查 | 保留 |

## 实施顺序

1. 将 meta-skill 明确收口到 meta-agent，不再给普通 group 使用
2. 移除普通 group 的 self-improve / evolution 触发机制
3. 保留并强化 meta-agent 的 meta-triage / daily-audit / wiki-lint
4. 创建 checkpoint 目录结构
5. 注册和维护 meta-agent 定时任务（meta-triage 高频巡检，daily-audit 22:00）
