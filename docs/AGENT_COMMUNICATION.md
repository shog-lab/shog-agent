# Optional Governance Escalation Channel

## 概述

当前主分支不再把 agent request / mailbox 作为日常治理主流程。

默认模式是：
- 各 group 自己优化自己
- main group 通过定期审计进行兜底

因此，agent 间的治理上报通道目前只保留为**可选的升级接口**，而不是日常必经路径。

## 当前定位

当前这条通道用于少数需要上升到主 group 处理的问题，例如：
- 平台级 extension 需求
- 安全边界问题
- 跨 group 规则冲突
- 宿主层机制缺陷

它当前**不是**用于：
- 每个 group 的日常 skill 微调
- 每个 group 的日常 AGENTS.md 优化
- 普通 workflow 层的自改

## 当前实现

保留的实现基础：
- IPC 类型 `agent_message`
- 宿主代投递逻辑
- `raw/mailbox/inbox/` 目录作为留痕位置

这些实现当前主要用于保留升级接口与未来扩展空间，不再作为核心治理机制。
