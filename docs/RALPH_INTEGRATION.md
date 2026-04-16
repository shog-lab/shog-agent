# Ralph 集成方案

## 概述

通过 Ralph（自动化 AI 编码循环）让好望角的 spec 自动变成代码。好望角写 spec，触发宿主执行 Ralph，Ralph 循环调 Claude Code 写代码，好望角跑 browser-test 验证。

## 架构

```
好望角 agent（容器内）
    │
    │ 1. 写 spec → 转成 prd.json
    │ 2. IPC 请求："执行 ralph"
    │
    ▼
宿主进程（IPC handler）
    │
    │ 3. 校验请求（白名单、目标 repo）
    │ 4. cd {repo} && ./scripts/ralph/ralph.sh --tool claude {iterations}
    │
    ▼
Ralph（宿主机 shell 脚本）
    │
    │ 循环：
    │   5. 读 prd.json 找最高优先级未完成 story
    │   6. 启动 claude -p 实现该 story
    │   7. 跑测试（类型检查、单测）
    │   8. 提交成功的改动
    │   9. 标记 story 完成
    │   10. 记录 learnings 到 progress.txt
    │   重复直到全部完成或达到迭代上限
    │
    ▼
好望角 agent（容器内）
    │
    │ 11. 收到"ralph 完成"通知
    │ 12. 跑 browser-test 验证功能
    │ 13. 结果汇报到钉钉群
    ▼
```

## 前置条件

- 目标 repo 安装 Ralph（`scripts/ralph/ralph.sh` + `CLAUDE.md` + `prd.json`）
- 宿主机有 Claude Code CLI（`claude` 命令可用）
- 好望角容器通过 codeRepos 挂载目标 repo（只读即可，Ralph 在宿主侧执行）

## 需要改的代码

### 1. 宿主侧：新增 IPC handler（src/ipc.ts）

处理 `type: 'exec_ralph'` 请求：

```typescript
case 'exec_ralph':
  // 校验
  if (!isAllowedRepo(data.repo)) {
    logger.warn({ repo: data.repo }, 'Blocked ralph execution');
    break;
  }
  // 创建分支 → 执行 ralph → 返回结果
  execRalph(data.repo, data.feature, data.iterations, (result) => {
    // 写回 IPC response
  });
  break;
```

执行流程：
```bash
cd {repo}
git checkout -b ralph/{feature}   # 1. 创建独立分支
./scripts/ralph/ralph.sh --tool claude {iterations}  # 2. 跑 Ralph
# 3. 完成后留在分支上，等人 review
# 4. 返回结果（成功/失败 + 完成的 story 数）
```

Ralph 的所有改动都在 `ralph/{feature}` 分支上，不碰 main。人 review 后手动合并。

### 2. 护栏

**Repo 白名单：** 只允许在 containerConfig.codeRepos 里注册过的 repo 下执行。

**分支隔离：** Ralph 始终在 `ralph/{feature}` 分支上跑，不碰 main/master。IPC handler 在执行前创建分支，不由 Ralph 或 Claude Code 决定。

**执行参数限制：**
- `--tool claude` 固定
- iterations 上限（最多 20）
- 超时（最多 60 分钟）

**Claude Code 护栏（CLAUDE.md 里约束）：**
- 不修改 repo 之外的文件
- 不执行危险命令（rm -rf、git push --force 等）
- 每个 story 完成后必须跑测试
- 不要 git merge/rebase/push

### 3. 容器侧：新增 IPC 工具（ipc-tools.ts）

```typescript
const execRalph: ToolDefinition = {
  name: 'exec_ralph',
  description: 'Trigger Ralph to auto-implement a feature. Runs on a separate git branch.',
  parameters: {
    repo: '/path/to/target/repo',
    feature: 'feature-name',       // → branch: ralph/feature-name
    iterations: 10,                 // max iterations
  },
  execute: async (params) => {
    // 写 IPC 请求文件，轮询等待结果
  },
};
```

### 4. 好望角：新增 skill

```
skills/
└── auto-implement/
    └── SKILL.md    — spec → prd.json → 触发 ralph → browser-test
```

## 流程细节

### Step 1: 好望角写 spec

已有 write-spec skill。spec 存在 `specs/{功能名}/spec.md`。

### Step 2: spec → prd.json

Ralph 有内置的 PRD 生成 skill。或者好望角直接把 spec 转成 prd.json 格式：

```json
{
  "stories": [
    {
      "id": "1",
      "title": "实现登录页面",
      "description": "...",
      "acceptance_criteria": ["..."],
      "passes": false
    }
  ]
}
```

关键：story 粒度要小，一个 story 在一个 context window 内能完成。

### Step 3: 触发 Ralph

好望角调 `exec_script` 工具：
```
exec_script("scripts/ralph/ralph.sh", "/path/to/repo", "--tool claude 10")
```

### Step 4: 等待完成

宿主异步执行 Ralph。执行过程中 Ralph 自动：
- 循环调 Claude Code
- 每完成一个 story 提交 git
- 更新 prd.json 和 progress.txt
- 全部完成或达到上限后退出

### Step 5: browser-test 验证

Ralph 完成后，好望角收到通知，用 browser-test skill 验证：
- 打开 `http://host.docker.internal:{port}`
- 按 spec 的验收标准逐项测试
- 生成测试报告

## 安全边界

| 风险 | 防护 |
|------|------|
| 容器 agent 执行任意命令 | 专用 exec_ralph 工具，不是通用 exec_script |
| Ralph 改坏 main 分支 | 分支隔离，始终在 ralph/{feature} 上 |
| Ralph 修改非目标文件 | cwd 限制在目标 repo |
| Claude Code 越界操作 | CLAUDE.md 约束 + 不允许 push/merge |
| 无限循环消耗资源 | iterations 上限 + 超时 |
| prompt 注入 | prd.json 是结构化数据，不是自由文本 |
| 改动质量差 | 人 review 分支后才合并 |

## 不需要改的

- Ralph 本身（原样安装到目标 repo）
- 好望角的 write-spec 和 browser-test skill
- 容器 agent 的能力（不需要写代码能力）
- 记忆系统

## 预估工作量

| 改动 | 复杂度 |
|------|--------|
| IPC handler（exec_script） | 中 — 新增一个 case，加白名单校验和子进程管理 |
| 容器侧 exec_script 工具 | 小 — 类似 delegate_task 的 IPC 写文件 + 轮询结果 |
| auto-implement skill | 小 — 串联 spec → prd.json → exec_script → browser-test |
| 目标 repo 安装 Ralph | 小 — 复制脚本 + 写 CLAUDE.md |
