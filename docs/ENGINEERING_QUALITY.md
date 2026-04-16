# 工程质量优化

## 已完成

- [x] **VerifyCommand**：验证命令白名单，分类为 read/verify/browser/file/git（`src/verify-command.ts`）
- [x] **Risk scorer**：4 轴风险评估 + 拦截接入（`src/risk-scorer.ts`）
- [x] **Governance config**：统一约束配置 + riskThreshold 完整打通（`GovernanceConfig` in `types.ts`）
- [x] **Intent declaration**：系统提示词要求 agent 调工具前先说意图
- [x] **KG 重构**：独立 `knowledge-graph.ts`，实体管理 + 去重 + 置信度 + 双向查询
- [x] **统一错误处理**：`src/errors.ts` — ErrorCode 枚举 + makeError + isError
- [x] **抽象提取**：`src/spawn-utils.ts`（进程捕获）+ `src/git-worktree.ts`（worktree 生命周期），claude-code.ts 从 490 行减到 305 行
- [x] **Memory extension 测试**：36 个测试覆盖 core.ts
- [x] **claude-code.ts 测试**：10 个测试覆盖 validateRepo
- [x] **IPC 集成测试**：11 个测试覆盖 exec_ralph/exec_claude 完整流程
- [x] **新模块测试**：verify-command（10）、risk-scorer（14）、knowledge-graph（28）、errors（6）、spawn-utils（5）、git-worktree（7）

测试总数：290 → 417

## 未完成

#### 可靠性
- [ ] **Checkpoint / 崩溃恢复**：exec_ralph 长时间执行中途崩溃时能从 checkpoint 恢复
- [ ] **Trace / 可观测性**：结构化 span 跟踪，至少覆盖 exec_ralph/exec_claude 执行过程

#### 安全
- [ ] **VerifyCommand 深化**：shell 组合禁止（`&&`、`||`、`|`、`>`）的解析级拦截

#### 文档
- [ ] **架构图**：SVG 画出完整执行流
- [ ] **Contributing 指南**：代码风格、提交规范、测试要求
- [ ] **Benchmark 可视化**：LongMemEval 横向对比 + 消融实验做成图表
