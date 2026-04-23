/**
 * ShogAgent Meta-Request Extension
 *
 * Monitors agent_end events for optimization/governance signals.
 * When signals are detected, writes a meta-request file into the group's
 * raw/meta-requests/ directory instead of triggering self-modification.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

interface AgentMessage {
  role: string;
  content: unknown;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: { type?: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text || "")
      .join("\n");
  }
  return "";
}

function detectSignals(messages: AgentMessage[]): string[] {
  const signals = new Set<string>();

  for (const msg of messages) {
    const text = extractText(msg.content);
    if (!text) continue;

    if (msg.role === "user") {
      if (/不对|不是这样|你搞错|你错了|wrong|incorrect/i.test(text)) {
        signals.add("用户纠正了错误");
      }
      if (/记住|记一下|remember/i.test(text)) {
        signals.add("用户要求记住信息");
      }
      if (/skill|流程|规则|提示词|AGENTS|extension|扩展|技能/i.test(text)) {
        signals.add("用户提到了需要调整能力或规则");
      }
    }

    if (msg.role === "assistant") {
      if (/抱歉.*错|我搞错了|sorry.*mistake/i.test(text)) {
        signals.add("agent 承认了错误");
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; isError?: boolean }>) {
        if (block.type === "tool_result" && block.isError) {
          signals.add("工具执行失败");
          break;
        }
      }
    }
  }

  return [...signals];
}

function shouldSkip(messages: AgentMessage[]): boolean {
  const allText = messages.map((m) => extractText(m.content)).join("\n");
  return /self-improve|meta-request|病例|巡检病例/i.test(allText);
}

export default function selfImproveExtension(pi: ExtensionAPI) {
  pi.on("agent_end", (event) => {
    const messages = (event as { messages?: AgentMessage[] }).messages;
    if (!messages || messages.length === 0) return;
    if (shouldSkip(messages)) return;

    const signals = detectSignals(messages);
    if (signals.length === 0) return;

    const groupDir = "/workspace/group";
    const requestsDir = join(groupDir, "raw", "meta-requests");
    mkdirSync(requestsDir, { recursive: true });

    const recentMessages = messages.slice(-8);
    const context = recentMessages
      .map((m) => `- [${m.role}] ${extractText(m.content).slice(0, 800)}`)
      .join("\n");

    const date = new Date().toISOString();
    const filename = `${date.replace(/[:.]/g, "-")}-meta-request.md`;
    const filepath = join(requestsDir, filename);
    if (existsSync(filepath)) return;

    const content = `---
type: meta-request
status: open
date: ${date}
signals:
${signals.map((s) => `  - ${s}`).join("\n")}
---

## 问题概述
检测到本次对话/执行中存在需要 meta-agent 评估的信号，普通 group 不自行修改 skills、AGENTS.md、extensions 或治理规则。

## 最近上下文
${context || "- 无可提取上下文"}

## 建议处理方向
- 判断是否需要修改 skills
- 判断是否需要修改 AGENTS.md / system prompt / extensions
- 判断是否只需补充 wiki 或维持现状
`;

    writeFileSync(filepath, content);
  });
}
