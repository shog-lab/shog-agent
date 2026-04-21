# Evolution

## 当前机制

当前采用“各 group 自优化 + 主 group 审核兜底”的模式。

核心原则：
- 各 group 在自身职责范围内优化自己的 AGENTS.md、skills、wiki 和工作方式
- 主 group 负责定期审核各 group 的改动质量与运行情况
- 主 group 发现明显退化时做最小修正或回滚
- 主 group 发现有通用价值的能力时，抽象上收到全局
- 平台级规则、安全边界、全局 extensions、宿主代码治理仍由主 group 负责

## 当前角色分工

| 角色 | 主要职责 |
|---|---|
| 普通 group | 执行业务任务，自主优化自身工作方式与本组能力 |
| main group / daily-audit | 审核各 group 改动质量，发现退化时兜底回滚 |
| main group / wiki-lint | 维护 wiki 质量 |

## 当前启用的治理能力

- `daily-audit`
- `wiki-lint`

## 当前不做的事

- 主 group 高频审批各 group 的日常优化
- 以 meta-triage 为核心的治理分诊流程
- 普通 group 修改平台级 extension 或安全边界
- 自动 memory 系统优化

更详细的历史方案、候选机制和阶段性治理思考已迁移到 shog wiki。
