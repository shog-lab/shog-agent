/**
 * ShogAgent Memory Extension for pi-coding-agent
 *
 * Hooks into agent lifecycle:
 * - turn_end → archive session every N turns
 * - session_compact → auto-save compaction summary + do B+D maintenance
 * - before_agent_start → inject L1 + L2/L3 memories + KG into system prompt
 */

import type { ExtensionAPI from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { MemoryCore } from "./core.js";

// --- Config ---

const GROUP_DIR = process.env.GROUP_DIR || "/workspace/group";
const DB_PATH = join(GROUP_DIR, ".wiki-index.db");
const LEGACY_MEMORY_DIR = join(GROUP_DIR, "memory");
const LEGACY_LLM_WIKI_DIR = join(GROUP_DIR, "llm-wiki");
const MIN_SCORE_THRESHOLD = 0.001;

// --- Environment detection ---

function isInContainer(): boolean {
  return existsSync("/.dockerenv") || process.env.IN_DOCKER === "1";
}

// --- Turn counter for session archival ---

let turnCount = 0;
const ARCHIVE_EVERY_N_TURNS = 10;

function archiveSession(): void {
  // Detect session source path (L1 in container vs L3 on host)
  let sessionSrc: string;
  if (isInContainer()) {
    sessionSrc = "/home/node/.pi/agent/sessions";
  } else {
    // L3 on host
    sessionSrc = join(process.env.HOME || "", ".pi", "agent", "sessions");
  }
  const rawSessionsDir = join(GROUP_DIR, "raw", "sessions");

  try {
    if (!existsSync(sessionSrc)) return;
    mkdirSync(rawSessionsDir, { recursive: true });

    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (entry.name.endsWith(".jsonl")) {
          const rel = relative(sessionSrc, full);
          const dest = join(rawSessionsDir, rel);
          mkdirSync(dirname(dest), { recursive: true });
          try {
            copyFileSync(full, dest);
          } catch {
            // skip individual copy failures
          }
        }
      }
    };
    visit(sessionSrc);
  } catch {
    // Non-fatal
  }
}

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

// --- B: classify summary and determine if wiki entry is needed ---

const DECISION_PATTERNS = [
  /decided|chose|adopted|will use|instead of|replaced|switched to|migrated to|using (?!this|that|the)/i,
  /(?:new|changed|updated) (?:approach|strategy|method|model|architecture)/i,
  /deprecated|废弃|停用|不再使用/i,
];

const FACT_PATTERNS = [
  /^[-*] .+(?:installed|deployed|built|created|implemented)/im,
  /(?:built|deployed|installed|implemented) .+ on \d{4}-\d{2}-\d{2}/i,
  /\d+ (?:files?|sessions?|tasks?|groups?|agents?)/i,
  /(?:error|bug|issue) .+ (?:fixed|resolved|detected)/i,
];

/**
 * Classify summary text and return memory type, or null if not worth saving
 */
function classifySummary(summary: string): string | null {
  const lines = summary.split("\n").filter((l) => l.trim());

  // Skip very short summaries
  if (lines.length < 3) return null;

  // Decision: strong signal
  if (DECISION_PATTERNS.some((p) => p.test(summary))) {
    return "decision";
  }

  // Fact: moderate signal
  if (FACT_PATTERNS.some((p) => p.test(summary))) {
    return "fact";
  }

  // Note: if summary has substantial content, save as note
  if (summary.length > 500) {
    return "note";
  }

  return null;
}

// --- B continued: classify subject (who this is about) ---

const SUBJECT_PATTERNS: Array<{ pattern: RegExp; subject: string }> = [
  { pattern: /(?:用户说|user said|I was told|用户要求|用户希望|user want|user expect)/i, subject: "user" },
  { pattern: /(?:项目|project|代码|repository|架构|architecture|代码库|这个系统)/i, subject: "project" },
  { pattern: /(?:我建议|I suggest|I think|I recommend|我认为|我决定)/i, subject: "feedback" },
];

function classifySubject(summary: string): string {
  for (const { pattern, subject } of SUBJECT_PATTERNS) {
    if (pattern.test(summary)) return subject;
  }
  return "reference";
}

// --- B continued: maintenance log for observability ---

function logMaintenance(action: string, detail: Record<string, unknown>): void {
  const logDir = join(GROUP_DIR, "raw", "maintenance-log");
  try {
    mkdirSync(logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(logDir, `${date}.jsonl`);
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      ...detail,
    };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch {
    // Non-fatal
  }
}

// --- F: detect repeated goals and suggest/create skills ---

const GOAL_REPEAT_THRESHOLD = 3;
const RECENT_COMPACTIONS_TO_SCAN = 10;

function extractGoal(summary: string): string | null {
  const match = summary.match(/^##\s+Goal\s*\n([\s\S]*?)(?:\n##|\n---)/m);
  if (!match) return null;
  const goal = match[1].trim();
  if (!goal) return null;
  // Use only first line as the goal key (most stable for comparison)
  const firstLine = goal.split("\n")[0].replace(/^[-*\d.\s]+/, "").trim();
  return firstLine.length > 0 ? firstLine : null;
}

function goalSimilarity(a: string, b: string): number {
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
  const aTokens = tokens(a);
  const bTokens = tokens(b);
  const intersection = [...aTokens].filter((t) => bTokens.has(t)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function detectSkillPattern(): string | null {
  const compactionDir = join(GROUP_DIR, "raw", "compaction");
  if (!existsSync(compactionDir)) return null;

  try {
    const files = readdirSync(compactionDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f,
        mtime: statSync(join(compactionDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, RECENT_COMPACTIONS_TO_SCAN);

    if (files.length < GOAL_REPEAT_THRESHOLD) return null;

    const goals: Array<{ goal: string; count: number }> = [];
    for (const { name } of files) {
      const content = readFileSync(join(compactionDir, name), "utf-8");
      const goal = extractGoal(content);
      if (!goal) continue;

      const existing = goals.find((g) => goalSimilarity(g.goal, goal) >= 0.7);
      if (existing) {
        existing.count++;
      } else {
        goals.push({ goal, count: 1 });
      }
    }

    const repeated = goals.find((g) => g.count >= GOAL_REPEAT_THRESHOLD);
    if (!repeated) return null;

    // Build skill name from first line, strip parenthetical suffixes
    const firstLine = repeated.goal.split("\n")[0].replace(/\s*\([^)]*\)/g, "").trim();
    const skillName = firstLine
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);

    if (!skillName) return null;

    // Check if skill already exists
    const skillDir = join(GROUP_DIR, "skills", skillName);
    if (existsSync(skillDir)) return null;

    // Write skill file
    const skillContent = `---  
description: Auto-generated skill from repeated goal pattern.
---

# ${repeated.goal.split("\n")[0].trim()}

Auto-created after detecting this goal repeated ${repeated.count} times across compactions.
`;
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skillContent, "utf-8");
    console.log(`[memory] Created skill "${skillName}" from repeated goal`);
    return skillName;
  } catch {
    return null;
  }
}

// --- Extension ---

export default function memExtension(pi: ExtensionAPI) {
  // On compaction: save summary + do B+D+F maintenance
  pi.on("session_compact", (event) => {
    const summary = event.compactionEntry.summary;
    const memType = classifySummary(summary);
    const subject = classifySubject(summary);

    // 1. Save compaction summary to raw/compaction/
    getCore().saveMemory("compaction", summary);

    // 2. B: auto-classify summary and write to wiki if worth preserving
    if (memType) {
      try {
        const wikiFile = getCore().saveMemory(memType, summary, [`subject:${subject}`]);
        logMaintenance("B", { memType, subject, wikiFile });
      } catch (e) {
        console.error("[memory] saveMemory failed:", e);
        logMaintenance("B-error", { memType, subject, error: String(e) });
      }
    } else {
      logMaintenance("B-skip", { reason: "too short or no type match" });
    }

    // 3. D: sync index so new files are indexed
    try {
      getCore().syncIndex();
      logMaintenance("D", { synced: true });
    } catch (e) {
      console.error("[memory] syncIndex failed:", e);
      logMaintenance("D-error", { error: String(e) });
    }

    // 4. F: detect repeated goals and create skill if pattern found
    try {
      const skillCreated = detectSkillPattern();
      logMaintenance("F", { skillCreated: skillCreated ?? "none" });
    } catch (e) {
      console.error("[memory] detectSkillPattern failed:", e);
      logMaintenance("F-error", { error: String(e) });
    }
  });

  // Archive session every N turns (non-blocking, no spawn)
  pi.on("turn_end", () => {
    turnCount++;
    if (turnCount % ARCHIVE_EVERY_N_TURNS === 0) {
      try {
        archiveSession();
      } catch {
        // Non-fatal
      }
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
