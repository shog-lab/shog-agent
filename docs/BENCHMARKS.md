# Benchmarks

ShogAgent 可跑的标准 benchmark，用于量化评估各维度能力。

## 记忆能力

| Benchmark | 论文 | 测什么 | 链接 |
|-----------|------|--------|------|
| **LongMemEval** | ICLR 2025 | 500 题，5 种记忆能力（信息提取、多轮推理、时间推理、知识更新、拒绝回答） | [GitHub](https://github.com/xiaowu0162/LongMemEval) |
| **LoCoMo** | — | 长期对话记忆（QA + 摘要 + 多模态），MemPalace 96.6% 用的这个 | [Website](https://snap-research.github.io/locomo/) |
| **MemoryAgentBench** | ICLR 2026 | 4 种能力：准确检索、运行时学习、长程理解、选择性遗忘 | [GitHub](https://github.com/HUST-AI-HYZ/MemoryAgentBench) |

## 浏览器自动化

| Benchmark | 测什么 | 链接 |
|-----------|--------|------|
| **WebBench** | 2500+ 网页读取和操作任务 | [GitHub](https://github.com/Halluminate/WebBench) |
| **BrowseComp** | OpenAI 浏览器 agent 评测 | [OpenAI](https://openai.com/index/browsecomp/) |
| **BU Bench** | 100 个高难度浏览器任务 | [Browser-Use](https://browser-use.com/posts/ai-browser-agent-benchmark) |

## 代码编写

| Benchmark | 测什么 | 链接 |
|-----------|--------|------|
| **SWE-Bench** | 解决真实 GitHub issue | [Website](https://www.swebench.com/) |
| **Terminal-Bench** | 命令行多步操作 | [Tessl](https://tessl.io/blog/8-benchmarks-shaping-the-next-generation-of-ai-agents/) |
| **FeatureBench** | 完整功能开发 | [arXiv](https://arxiv.org/html/2602.10975v1) |

## 代码修复

| Benchmark | 测什么 | 链接 |
|-----------|--------|------|
| **Repository-repair** | 10 轮修 bug 循环，测修复率 + 耗时（prax-agent 用的） | [GitHub](https://github.com/ChanningLua/prax-agent/blob/main/docs/BENCHMARKS.md) |

## 综合参考

| 资源 | 说明 | 链接 |
|------|------|------|
| **Agent Benchmark Compendium** | 50+ benchmark 合集索引 | [GitHub](https://github.com/philschmid/ai-agent-benchmark-compendium) |
| **Anthropic Evals Guide** | Agent 评估方法论 | [Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) |

## 已有结果

### LongMemEval Oracle (2026-04-10)

评估模型：DeepSeek Chat | Token 预算：16000 | Stopwords 过滤：是

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

横向对比（同一 benchmark，不同系统）：

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
