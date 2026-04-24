/**
 * ShogAgent Governance Request Extension
 *
 * Monitors agent_end events for optimization/governance signals.
 * When signals are detected, writes an IPC task for the host to deliver
 * a minimal governance request to the meta-agent.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const IPC_DIR = process.env.IPC_DIR || "/workspace/ipc";
const TASKS_DIR = join(IPC_DIR, "tasks");
const META_AGENT_FOLDER = process.env.META_AGENT_FOLDER || "dingtalk-shog";
const GROUP_FOLDER = process.env.GROUP_FOLDER || "unknown-group";

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
  return /governance request|meta-triage|巡检收件箱|治理上报/i.test(allText);
}

function writeIpcFile(data: object): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = join(TASKS_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2));
  renameSync(tempPath, filepath);
}

export default function selfImproveExtension(pi: ExtensionAPI) {
  pi.on("agent_end", (event) => {
    const messages = (event as { messages?: AgentMessage[] }).messages;
    if (!messages || messages.length === 0) return;
    if (shouldSkip(messages)) return;
    if (GROUP_FOLDER === META_AGENT_FOLDER) return;

    const signals = detectSignals(messages);
    if (signals.length === 0) return;

    const recentMessages = messages.slice(-8);
    const context = recentMessages
      .map((m) => `- [${m.role}] ${extractText(m.content).slice(0, 800)}`)
      .join("\n");

    writeIpcFile({
      type: "agent_message",
      from: GROUP_FOLDER,
      to: META_AGENT_FOLDER,
      subject: "governance signal report",
      content: `检测到本次对话/执行中存在需要治理侧评估的信号。\n\nSignals:\n- ${signals.join("\n- ")}\n\n## 最近上下文\n${context || "- 无可提取上下文"}`,
    });
  });
}
