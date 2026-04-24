# Benchmarks

## 当前关注的指标

### 记忆
- **LongMemEval**：标准记忆能力
- **LoCoMo**：长期对话记忆
- **MemoryAgentBench**：agent memory 能力
- **真实任务记忆测评（内部）**：命中、漏召回、错误记忆、wiki 质量

### 代码与执行
- **SWE-Bench**：真实 GitHub issue 修复
- **Terminal-Bench**：多步 CLI / Bash 执行
- **Repository-repair**：多轮修 bug 闭环
- **Repo Task Regression Set（内部）**：L2 repo agent 黑盒任务

### 行为与回归
- **Group Evolution Regression Set（内部）**：group 自优化后是否退化

### 浏览器
- **WebBench**：网页读取与操作
- **BrowseComp**：浏览器 agent 评测参考
- **BU Bench**：高难浏览器任务

## 当前结果摘要

- **LongMemEval 当前最好结果：77.4%**（向量搜索 + L1 + KG）
- **LongMemEval Oracle（2026-04-10）：74.4%**（FTS5 + stopwords + L1 + 类型权重）
- 当前已知短板：**temporal-reasoning**

详细实验结果、横向对比、消融记录已迁移到 shog wiki 管理。
