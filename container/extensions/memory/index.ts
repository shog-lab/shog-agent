/**
 * ShogAgent Memory Extension for pi-coding-agent
 *
 * Thin wrapper around MemoryCore. Hooks into agent lifecycle:
 * - session_compact → auto-save compaction summaries to wiki/compaction/
 * - before_agent_start → inject L1 + L2/L3 memories + KG into system prompt
 *
 * All logic lives in core.ts. This file only does wiring.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
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
  // Migrate llm-wiki/ if it exists (only for dingtalk-shog initially)
  if (existsSync(LEGACY_LLM_WIKI_DIR)) {
    core.migrateLegacyLlmWiki(LEGACY_LLM_WIKI_DIR);
  }
  core.syncIndex();
  return core;
}

// --- Extension ---

export default function memExtension(pi: ExtensionAPI) {
  // Auto-save compaction summaries
  pi.on("session_compact", (event) => {
    getCore().saveMemory("compaction", event.compactionEntry.summary);
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

    // L2/L3: Query-relevant search (FTS5 — vector search is async, handled in core.buildContext)
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

    // [[link]] resolution from search results
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

    // Knowledge graph: inject triples for entities mentioned in prompt
    const kgBlock = mc.buildKGContext(event.prompt);
    if (kgBlock) parts.push(kgBlock);

    if (parts.length === 0) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}`,
    };
  });
}
