/**
 * ShogAgent Memory Extension for pi-coding-agent
 *
 * Hooks into agent lifecycle:
 * - session_compact → auto-save compaction summary + spawn L2 for B+D+F
 * - before_agent_start → inject L1 + L2/L3 memories + KG into system prompt
 */

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MemoryCore } from "./core.js";

// --- Config ---

const GROUP_DIR = process.env.GROUP_DIR || "/workspace/group";
const DB_PATH = join(GROUP_DIR, ".wiki-index.db");
const LEGACY_MEMORY_DIR = join(GROUP_DIR, "memory");
const LEGACY_LLM_WIKI_DIR = join(GROUP_DIR, "llm-wiki");
const MIN_SCORE_THRESHOLD = 0.001;

// --- Singleton ---

let core: MemoryCore | null = null;

function getCore(): MemoryCore {
  if (core) return core;
  core = new MemoryCore({
    groupDir: GROUP_DIR,
    dbPath: DB_PATH,
    legacyMemoryDir: existsSync(LEGACY_MEMORY_DIR) ? LEGACY_MEMORY_DIR : undefined,
  });
  if (existsSync(LEGACY_LLM_WIKI_DIR)) {
    core.migrateLegacyLlmWiki(LEGACY_LLM_WIKI_DIR);
  }
  core.syncIndex();
  return core;
}

// --- B+D+F: spawn L2 for maintenance task ---

function isInContainer(): boolean {
  return existsSync("/.dockerenv") || process.env.IN_DOCKER === "1";
}

function findPiBin(): string {
  if (isInContainer()) {
    return "/app/node_modules/.bin/pi";
  }
  // L3 on host: find pi in PATH
  try {
    return execSync("which pi", { encoding: "utf8" }).trim();
  } catch {
    // Fallback
    return join(process.env.HOME || "", ".nvm", "versions", "node", "v24.14.0", "bin", "pi");
  }
}

function spawnMaintenanceL2(summaryFile: string): void {
  const piBin = findPiBin();
  const groupDir = GROUP_DIR;

  // Build minimal task prompt for B+D+F
  // L2 reads summary file, decides wiki entry, marks FTS5, writes skill if needed
  const taskPrompt = `Maintenance task for compaction summary.

Read the compaction summary at: ${summaryFile}

Group directory: ${groupDir}

Task:
1. Read the summary file
2. If it contains new decisions, facts, or patterns worth preserving → write a formal wiki entry to ${groupDir}/wiki/ (type: decision/fact/note, with frontmatter: date, type, tags)
3. Done. Report what you found/decided in plain text.`;

  const args = [
    "-p",
    "--no-extensions",
    "--model", process.env.MODEL ?? "minimax-cn/MiniMax-M2.7",
    "--append-system-prompt", "You are a maintenance sub-agent. Rules: do the task, write wiki entries if needed, return plain text summary of what you did.",
    taskPrompt,
  ];

  // Detached so hook doesn't block
  const proc = spawn(piBin, args, {
    cwd: groupDir,
    detached: true,
    stdio: "ignore",
  });

  proc.unref();
}

// --- Extension ---

export default function memExtension(pi: ExtensionAPI) {
  // On compaction: save summary + spawn L2 for B+D+F
  pi.on("session_compact", (event) => {
    // 1. Save compaction summary to raw/compaction/
    const summaryFile = getCore().saveMemory("compaction", event.compactionEntry.summary);

    // 2. Spawn L2 (detached) for B+D+F — non-blocking
    try {
      spawnMaintenanceL2(summaryFile);
    } catch (e) {
      console.error("[memory] Failed to spawn maintenance L2:", e);
    }
  });

  // Inject memories before agent starts processing
  pi.on("before_agent_start", (event) => {
    const mc = getCore();
    mc.syncIndex();

    const parts: string[] = [];

    // L1: Always inject preferences, decisions, facts
    const l1Entries = mc.loadL1();
    if (l1Entries.length > 0) {
      const lines = ["<critical-memory>"];
      let totalTokens = 0;
      for (const entry of l1Entries) {
        const tokens = Math.ceil(entry.content.length / 4);
        if (totalTokens + tokens > 2000 && lines.length > 1) break;
        const memType = entry.type;
        lines.push(`\n### ${memType} (${entry.date.slice(0, 10)})\n`);
        lines.push(entry.content);
        totalTokens += tokens;
      }
      lines.push("\n</critical-memory>");
      parts.push(lines.join("\n"));
    }

    // L2/L3: Query-relevant search (FTS5)
    const l1Paths = new Set(l1Entries.map((e) => e.filePath));
    const searchResults = mc.searchFTS5(event.prompt)
      .filter((r) => r.score >= MIN_SCORE_THRESHOLD && !l1Paths.has(r.entry.filePath));

    if (searchResults.length > 0) {
      const lines = ["<long-term-memory>"];
      for (const { entry, score } of searchResults) {
        const meta = [`type=${entry.type}`, `date=${entry.date.slice(0, 10)}`];
        if (entry.tags?.length) {
          const displayTags = entry.tags.filter((t) => !t.startsWith("memory-type:"));
          if (displayTags.length) meta.push(`tags=${displayTags.join(",")}`);
        }
        lines.push(`\n### Memory (${meta.join(" | ")} | relevance=${score.toFixed(2)})\n`);
        lines.push(entry.content);
      }
      lines.push("\n</long-term-memory>");
      parts.push(lines.join("\n"));
    }

    // [[link]] resolution
    const seenPaths = new Set([...l1Paths, ...searchResults.map((r) => r.entry.filePath)]);
    const linkedEntries = [];
    for (const { entry } of searchResults) {
      for (const linked of mc.resolveLinkedContent(entry.content)) {
        if (!seenPaths.has(linked.filePath)) {
          seenPaths.add(linked.filePath);
          linkedEntries.push(linked);
        }
      }
    }
    if (linkedEntries.length > 0) {
      const lines = ["<linked-pages>"];
      for (const entry of linkedEntries) {
        const slug = basename(entry.filePath, ".md");
        lines.push(`\n### [[${slug}]]\n`);
        const truncated = entry.content.length > 2000
          ? entry.content.slice(0, 2000) + "\n...(truncated)"
          : entry.content;
        lines.push(truncated);
      }
      lines.push("\n</linked-pages>");
      parts.push(lines.join("\n"));
    }

    // Knowledge graph
    const kgBlock = mc.buildKGContext(event.prompt);
    if (kgBlock) parts.push(kgBlock);

    if (parts.length === 0) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}`,
    };
  });
}
