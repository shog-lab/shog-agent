# 工程质量优化

## 已完成

- [x] **Intent declaration**：系统提示词要求 agent 调工具前先说意图（`<internal>` 标签包裹，不泄露给用户）
- [x] **KG 重构**：独立 `knowledge-graph.ts`，实体管理 + 去重 + 置信度 + 双向查询
- [x] **统一错误处理**：`src/errors.ts` — ErrorCode 枚举 + makeError + isError
- [x] **Memory extension 测试**：36 个测试覆盖 core.ts
- [x] **knowledge-graph 测试**：28 个测试
- [x] **RPC 迁移**：pi-coding-agent RPC 模式替代自建 agent runner，容器物理隔离替代代码层安全检查

## 未完成

#### 文档
- [ ] **架构图**：SVG 画出完整执行流（RPC 架构）
- [ ] **Contributing 指南**：代码风格、提交规范、测试要求
- [ ] **Benchmark 可视化**：LongMemEval 横向对比 + 消融实验做成图表
