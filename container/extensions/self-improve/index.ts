/**
 * ShogAgent Self-Improve Extension
 *
 * Monitors agent_end events for optimization signals.
 * When signals are detected, writes an IPC request for the host
 * to trigger a self-improvement prompt via RPC.
 *
 * Signal detection is heuristic-based (lightweight).
 * The actual LLM-quality analysis happens when the agent
 * processes the self-improve skill in the follow-up prompt.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const IPC_DIR = process.env.IPC_DIR || "/workspace/ipc";
const TASKS_DIR = join(IPC_DIR, "tasks");

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

/**
 * Check conversation for optimization signals.
 * Returns a brief description if signals found, null otherwise.
 */
function detectSignals(messages: AgentMessage[]): string | null {
  const signals: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    if (!text) continue;

    if (msg.role === "user") {
      // User correction patterns
      if (/不对|不是这样|你搞错|你错了|wrong|incorrect/i.test(text)) {
        signals.push("用户纠正了错误");
      }
      // User explicitly asking to remember
      if (/记住|记一下|remember/i.test(text)) {
        signals.push("用户要求记住信息");
      }
    }

    if (msg.role === "assistant") {
      // Agent acknowledging mistakes
      if (/抱歉.*错|我搞错了|sorry.*mistake/i.test(text)) {
        signals.push("agent 承认了错误");
      }
    }
  }

  // Check for tool execution failures (content blocks with isError)
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; isError?: boolean }>) {
        if (block.type === "tool_result" && block.isError) {
          signals.push("工具执行失败");
          break;
        }
      }
    }
  }

  if (signals.length === 0) return null;
  return signals.join("；");
}

function writeIpcFile(data: object): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = join(TASKS_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2));
  // Atomic rename
  const { renameSync } = require("node:fs");
  renameSync(tempPath, filepath);
}

export default function selfImproveExtension(pi: ExtensionAPI) {
  pi.on("agent_end", (event) => {
    const messages = (event as { messages?: AgentMessage[] }).messages;
    if (!messages || messages.length === 0) return;

    const signals = detectSignals(messages);
    if (!signals) return;

    // Extract last few messages as context for self-improvement
    const recentMessages = messages.slice(-6);
    const context = recentMessages
      .map((m) => `[${m.role}] ${extractText(m.content).slice(0, 500)}`)
      .join("\n");

    writeIpcFile({
      type: "self_improve",
      signals,
      context,
      timestamp: new Date().toISOString(),
    });
  });
}
