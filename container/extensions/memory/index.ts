/**
 * ShogAgent Memory Extension for pi-coding-agent
 *
 * Hooks into agent lifecycle:
 * - turn_end → archive session every N turns
 * - session_compact → auto-save compaction summary + do B+D maintenance
 * - before_agent_start → inject L1 + L2/L3 memories + KG into system prompt
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

// --- Maintenance log for observability ---

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

    // Collect all compaction summaries related to this repeated goal
    const relatedSummaries: string[] = [];
    for (const { name } of files) {
      const content = readFileSync(join(compactionDir, name), "utf-8");
      const goal = extractGoal(content);
      if (goal && goalSimilarity(goal, repeated.goal) >= 0.7) {
        // Strip frontmatter and return just the body
        const body = content.replace(/^---[\s\S]*?---\n/, "").slice(0, 2000);
        relatedSummaries.push(`=== ${name} ===\n${body}`);
      }
    }

    return { goal: repeated.goal, summaries: relatedSummaries.join("\n\n"), count: repeated.count };
  } catch {
    return null;
  }
}

// --- L2 spawn helpers for B and F tasks ---

const PI_BIN = "/app/node_modules/.bin/pi";

/** Spawn L2 to execute B (classify subject + write wiki) or F (generate skill content) */
function spawnL2Task(taskType: "B" | "F", params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const systemPrompt = taskType === "B"
      ? [
          "You are a memory classifier sub-agent.",
          "Read the summary below, classify its subject (who this is about), and write it to the wiki.",
          "",
          "Rules:",
          "- Classify subject as one of: user, project, feedback, reference",
          "- Write the content to <GROUP_DIR>/wiki/ as a .md file",
          "- Use frontmatter: date, type=memory, tags=[subject:<value>]",
          '- Return JSON: {"subject": "<value>", "wikiFile": "<path written>"}',
          "",
          `<GROUP_DIR> is ${process.env.GROUP_DIR || "/workspace/group"}`,
        ].join("\n")
      : [
          "You are a skill synthesizer sub-agent.",
          "Read the provided goal and related compaction summaries, then generate a useful SKILL.md.",
          "",
          "Rules:",
          "- Extract constraints, decisions, typical next steps from the summaries",
          "- Generate concrete, actionable skill content",
          "- Write to <GROUP_DIR>/skills/<slug>/SKILL.md",
          '- Return JSON: {"skillName": "<slug>", "skillFile": "<path written>"}',
          "",
          `<GROUP_DIR> is ${process.env.GROUP_DIR || "/workspace/group"}`,
        ].join("\n");

    const taskPrompt = taskType === "B"
      ? `Classify this summary:\n\n${params.summary}\n\nReturn JSON with subject and wikiFile.`
      : `Goal: ${params.goal}\n\nRelated compaction summaries:\n${params.summaries}\n\nReturn JSON with skillName and skillFile.`;

    const proc = spawn(PI_BIN, [
      "-p",
      "--no-extensions",
      "--model", process.env.MODEL ?? "minimax-cn/MiniMax-M2.7",
      "--append-system-prompt", systemPrompt,
      taskPrompt,
    ], {
      cwd: process.env.GROUP_DIR || "/workspace/group",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    proc.stdout?.on("data", (d) => { output += d.toString(); });
    proc.stderr?.on("data", (d) => { output += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ ok: false, error: "timeout after 60s" });
    }, 60000);

    proc.on("close", () => {
      clearTimeout(timer);
      const jsonMatch = output.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        resolve(JSON.parse(jsonMatch[0]));
      } else {
        resolve({ ok: false, error: "no JSON in L2 output", raw: output.slice(0, 200) });
      }
    });

    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e) });
    });
  });
}
// --- Extension ---

export default function memExtension(pi: ExtensionAPI) {
  // On compaction: save summary + do B+D+F maintenance
  pi.on("session_compact", async (event) => {
    const summary = event.compactionEntry.summary;

    // 1. Save compaction summary to raw/compaction/
    getCore().saveMemory("compaction", summary);

    // 2. B: spawn L2 to classify subject and write wiki entry
    // 2. B: spawn L2 to classify subject and write wiki entry
    const bResult = await spawnL2Task("B", { summary });
    if (bResult.ok !== false && bResult.wikiFile) {
      logMaintenance("B", { subject: bResult.subject, wikiFile: bResult.wikiFile });
    } else {
      console.error("[memory] B L2 failed:", bResult.error);
      logMaintenance("B-error", { error: bResult.error });
    }

    // 3. D: sync index (sync, no spawn)
    try {
      getCore().syncIndex();
      logMaintenance("D", { synced: true });
    } catch (e) {
      console.error("[memory] syncIndex failed:", e);
      logMaintenance("D-error", { error: String(e) });
    }

    // 4. F: detect repeated goals via pattern match, then spawn L2 to generate skill
    const skillResult = detectSkillPattern();
    if (skillResult) {
      const fResult = await spawnL2Task("F", { goal: skillResult.goal, summaries: skillResult.summaries });
      if (fResult.ok !== false && fResult.skillFile) {
        logMaintenance("F", { skillName: fResult.skillName, skillFile: fResult.skillFile });
      } else {
        console.error("[memory] F L2 failed:", fResult.error);
        logMaintenance("F-error", { error: fResult.error });
      }
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
