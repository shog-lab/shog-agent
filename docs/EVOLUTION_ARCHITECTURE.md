# 自进化架构

## 核心思路

主 group 作为"进化管理者"（MetaAgent），负责观察、评估和改进所有 group 的 harness。其他 group 作为"执行者"（TaskAgent），专注于各自的业务任务，不自行进化。

## 角色分工

### 主 group（MetaAgent）

- 拥有所有 group 的读写权限
- 读取其他 group 的对话记录，分析表现
- 修改其他 group 的 AGENTS.md、skills、memory
- 评估进化效果，回滚失败的改动
- 决定哪个 group 开放什么能力
- 自身也进化，但进化目标是"更好地管理其他 group"

### 普通 group（TaskAgent）

- 只有自己目录的读写权限
- 专注业务任务（需求管理、内容营销等）
- 不自行修改 AGENTS.md 和 skills
- 可以写 memory（记录事实和经验）

## 进化循环

```
主 group 观察对话记录
       │
       ▼
分析问题（哪些任务做得差、哪些规则不合理）
       │
       ▼
修改目标 group 的 harness（AGENTS.md / skills / memory）
       │
       ▼
目标 group 在后续任务中使用新 harness
       │
       ▼
主 group 再次观察，评估改动效果
       │
       ▼
效果好 → 保留；效果差 → 回滚
```

## 权限模型

### 当前状态

- 主 group 能只读其他 group 的对话记录（`/workspace/agents/` 挂载）
- 不能写其他 group 的目录
- 所有 group 共享相同的 evolution skill
- 权限硬编码在 `ipc-tools.ts` 和 `container-runner.ts`

### 目标状态

**Phase 1：主 group 读写所有 group 目录**

- 挂载所有 group 目录为可写（不只是对话记录）
- 主 group 能直接修改其他 group 的 AGENTS.md、skills、memory
- 其他 group 去掉 evolution skill，不再自行进化

**Phase 2：动态权限系统**

- 权限配置从代码抽到数据层（DB 或 group 配置文件）
- 主 group 能动态分配权限（如"给好望角开放 delegate_task"）
- 权限变更通过 IPC 通知宿主进程生效

**Phase 3：量化评估（HyperAgents）**

- 主 group 改完 harness 后，运行 benchmark 评估效果
- 对比改进前后的指标（任务完成率、用户满意度等）
- 多个策略变体并行测试，选优胜者保留

## 安全边界

- 主 group 不能修改宿主进程代码（`src/`），只能修改 Extension 层（AGENTS.md、skills、extensions、memory）
- 主 group 的 AGENTS.md 有不可删除的底线规则
- 所有进化操作记录在 memory/evolution-*.md 中，可审计
- 宿主进程保留最终控制权（可随时覆盖 agent 的改动）

## 与 HyperAgents 的关系

参考 Meta AI 的 HyperAgents（github.com/facebookresearch/Hyperagents）：

| HyperAgents | ShogAgent |
|-------------|----------|
| MetaAgent 修改 TaskAgent 代码 | 主 group 修改其他 group 的 harness |
| Docker 隔离执行 | Docker 容器隔离 |
| Benchmark 量化评估 | Phase 3 目标 |
| 多代竞争选优 | Phase 3 目标 |

关键区别：HyperAgents 优化的是可量化的任务（search、reasoning），ShogAgent 优化的是开放式业务任务（需求管理、内容营销），量化评估更难，需要定义业务相关的指标。
