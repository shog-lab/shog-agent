# Benchmarks

## 需要跑的指标

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

## 已有结果

### LongMemEval Oracle (2026-04-10)

评估模型：DeepSeek Chat  
Token 预算：16000  
Stopwords 过滤：是

**完整版（FTS5 + stopwords + L1 分层 + 知识图谱 + 类型权重）：74.4%**

| 类型 | 正确率 |
|------|--------|
| single-session-assistant | 100.0% (56/56) |
| single-session-user | 98.6% (69/70) |
| knowledge-update | 82.1% (64/78) |
| single-session-preference | 73.3% (22/30) |
| multi-session | 65.4% (87/133) |
| temporal-reasoning | 55.6% (74/133) |
| **Overall** | **74.4% (372/500)** |

横向对比：

| 系统 | LongMemEval Score | 说明 |
|------|------------------|------|
| MemPalace (raw verbatim) | 96.6% | ChromaDB 向量搜索，零 API 调用 |
| Mem0 | ~85% | 云服务，$19-249/mo |
| **ShogAgent** | **74.4%** | FTS5 全文搜索，纯本地，零成本 |
| Zep | ~85% | 云服务，$25/mo+ |

消融实验：

| 配置 | LongMemEval Score | 提升 |
|------|------------------|------|
| 基线（词项匹配） | 待测 | — |
| FTS5（无 stopwords） | 71.8% | — |
| FTS5 + stopwords + L1 + 类型权重 | 74.4% | +2.6 |
| **向量搜索（Ollama nomic-embed-text）+ L1 + KG** | **77.4%** | **+3.0** |

## 参考
- Agent Benchmark Compendium: <https://github.com/philschmid/ai-agent-benchmark-compendium>
- Anthropic Evals Guide: <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
