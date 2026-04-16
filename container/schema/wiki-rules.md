# Wiki Schema

wiki/ 是你的唯一知识存储。所有需要跨会话保留的信息都写入 wiki/。

## 目录结构

```
/workspace/group/
├── wiki/              ← 所有知识页面平铺在此（读写）
│   └── compaction/    ← [系统自动] 对话摘要，不要手动写
├── raw/               ← 原始资料（只存不改，来源追溯）
├── schema/            ← 本文件所在目录，wiki 操作规范
└── .wiki-index.db     ← 搜索索引（系统管理）
```

**关键规则：**
- 所有 wiki 页面直接放在 wiki/ 根目录，不要建子目录（compaction/ 除外）
- 分类靠 frontmatter 的 type 和 tags 字段，不靠目录
- 搜索系统递归扫描整个 wiki/，目录结构不影响检索

## Frontmatter

所有 wiki 页面必须有 frontmatter：

```yaml
---
date: 2026-04-14T00:00:00.000Z
type: fact|note|research|preference|decision|workflow
tags: [topic1, topic2]
---
```

**type 的作用：**
- `fact`、`preference`、`decision` → L1 记忆，每次对话自动注入（无需搜索命中）
- `note`、`research`、`workflow` → L2/L3 记忆，按查询相关性检索注入
- `compaction` → 系统自动生成，不要手动设置

涉及人物、时间、关系时**必须**添加知识图谱三元组：
```yaml
triples: [["主语", "谓语", "宾语"]]
```

## 页面互联

用 `[[page-name]]` 链接相关页面。系统自动加载被引用的页面：

```markdown
这项研究基于 [[agent-memory]] 的发现，与 [[agent-evolution]] 相关。
```

## 命名规范

文件名要有可读性，示例：
- `dark-mode-preference.md`
- `deltamem-arxiv-2604.md`
- `agent-memory.md`
- `meeting-notes-0414.md`

原始来源放 raw/：`arxiv-2604-04503.md`

## 五阶段流程

1. **Ingest** — 原始资料存入 raw/
2. **Compile** — 提炼为 wiki/ 页面（短、准、稳）
3. **Query** — 基于 wiki/ 回答问题
4. **Output** — 新知识回写 wiki/
5. **Lint** — 定期检查：去重、过期、质量
