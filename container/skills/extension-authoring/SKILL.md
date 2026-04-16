---
name: extension-authoring
description: 创建 pi-coding-agent extension。当你需要注册自定义工具或 hook agent 生命周期事件时使用。
---

# 创建 Extension

Extension 是 TypeScript 模块，可以注册自定义工具（tool）或 hook agent 生命周期事件。比内置 skill 更强大，适合需要调 API、处理数据等场景。

## 目录结构

```
/home/node/.pi/agent/extensions/
└── my-extension/
    ├── index.ts                ← 入口文件，export default 一个函数
    └── package.json            ← 如果需要第三方依赖
```

pi-coding-agent 启动时自动发现 `/home/node/.pi/agent/extensions/` 下的所有 extension。这个目录是持久化的（挂载回宿主），你创建的 extension 下次会话也能加载。注意：内建 extension（memory、jimeng）每次容器启动会被覆盖，不要修改它们，创建新的 extension 来扩展能力。

如果 extension 有第三方依赖，创建后需要在目录内运行 `cd /home/node/.pi/agent/extensions/my-extension && npm install`。

对于不需要注册工具或 hook 事件的场景，优先使用 skill（纯指令，更轻量）。

## index.ts 基本结构

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // 在这里注册工具或 hook 事件
}
```

## 注册自定义工具

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function myExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    description: "工具描述，agent 靠这个判断何时调用",
    input_schema: Type.Object({
      query: Type.String({ description: "查询内容" }),
    }),
    handler: async (input) => {
      // input 的类型自动推断自 input_schema
      const result = await doSomething(input.query);
      return { content: [{ type: "text", text: result }] };
    },
  });
}
```

## Hook 生命周期事件

```typescript
export default function myExtension(pi: ExtensionAPI) {
  // agent 开始处理前，可修改 systemPrompt
  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n额外指令...",
    };
  });

  // 对话压缩时自动触发
  pi.on("session_compact", (event) => {
    // 保存压缩摘要等
  });
}
```

## 现有 extension 参考

- **memory** (`/home/node/.pi/agent/extensions/memory/`) — 自动记忆管理，hook `session_compact` 和 `before_agent_start`
- **jimeng** (`/home/node/.pi/agent/extensions/jimeng/`) — 即梦图片生成，注册 `jimeng_generate` 工具

## 关键原则

- 入口文件必须 `export default` 一个接收 `ExtensionAPI` 的函数
- 工具的 `input_schema` 用 `@sinclair/typebox` 的 `Type` 定义
- handler 返回格式：`{ content: [{ type: "text", text: "..." }] }`
- 如果需要第三方包，在 `package.json` 声明依赖，创建后运行 `npm install`
- 文件操作使用 `/workspace/group/` 下的路径
- extension 比 skill 重，只在需要注册工具或 hook 事件时使用；纯指令流程用 skill 即可
