#!/usr/bin/env npx tsx
/**
 * Backfill subject tags for existing wiki entries.
 * Uses LLM to classify each entry's subject (user/project/feedback/reference).
 *
 * Run: npx tsx scripts/backfill-subject-tags.ts <group-name>
 * e.g.: npx tsx scripts/backfill-subject-tags.ts dingtalk-shog
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

const PI_BIN = "/app/node_modules/.bin/pi";

const L1_TYPES = new Set(["decision", "fact", "note"]);

const SYSTEM_PROMPT = [
  "You are a memory classifier. Classify each memory by subject.",
  "",
  "## user — User preferences, requests, or constraints",
  "When: The user explicitly asked for something or stated a preference/constraint",
  'Examples: "用户希望用 pm2 管理进程" / "用户要求不提命令行"',
  "",
  "## project — Project code, architecture, or technical decisions",
  "When: The content is about project structure, code, files, or how the system works",
  'Examples: "代码迁移到了 raw/compaction/" / "项目用 Docker 管理"',
  "",
  "## feedback — Agent's own suggestions, decisions, or reflections",
  "When: The agent recommends something, decides an approach, or reflects on what was done",
  'Examples: "我建议用 subject tag 分类" / "决定把 compaction 移出 wiki"',
  "",
  "## reference — External knowledge, docs, or research",
  "When: The content is about reading papers, docs, or external information",
  'Examples: "读了一篇关于 agent memory 的论文"',
  "",
  `Classify this content and return JSON: {"subject": "one of: user, project, feedback, reference"}`,
].join("\n");

function classifyWithLLM(content: string): string {
  try {
    const result = spawnSync(PI_BIN, [
      "-p",
      "--no-extensions",
      "--model", process.env.MODEL ?? "minimax-cn/MiniMax-M2.7",
      "--append-system-prompt", SYSTEM_PROMPT,
      `Classify this content:\n\n${content.slice(0, 3000)}\n\nReturn JSON.`,
    ], {
      timeout: 30000,
    });

    const output = (result.stdout as Buffer)?.toString() ?? "";
    const jsonMatch = output.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.subject && ["user", "project", "feedback", "reference"].includes(parsed.subject)) {
        return parsed.subject;
      }
    }
    return "reference";
  } catch {
    return "reference";
  }
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const metaBlock = raw.slice(4, end);
  const body = raw.slice(end + 4);
  const meta: Record<string, unknown> = {};
  for (const line of metaBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    meta[key] = value;
  }
  return { meta, body };
}

function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      const quoted = (value as string[]).map((v) => `"${v}"`).join(", ");
      lines.push(`${key}: [${quoted}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

function backfillSubjectTags(groupDir: string): void {
  const wikiDir = join(groupDir, "wiki");
  if (!existsSync(wikiDir)) {
    console.error("No wiki/ dir found in", groupDir);
    process.exit(1);
  }

  let files: string[] = [];
  try {
    files = readdirSync(wikiDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(wikiDir, f));
  } catch (e) {
    console.error("Failed to read wiki dir:", e);
    process.exit(1);
  }

  console.log(`Found ${files.length} wiki files in ${wikiDir}`);

  let updated = 0;
  let skipped = 0;
  let alreadyHas = 0;

  for (const filePath of files) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);

      const type = (meta.type as string) || "note";
      if (!L1_TYPES.has(type)) {
        skipped++;
        continue;
      }

      // Check if subject already exists
      const existingTags = meta.tags as string | undefined;
      const tagsStr = existingTags || "";
      const tagsList = tagsStr ? tagsStr.split(",").map((t: string) => t.trim()) : [];
      if (tagsList.some((t: string) => t.startsWith("subject:"))) {
        alreadyHas++;
        continue;
      }

      const subject = classifyWithLLM(body);
      const newTags = [...tagsList, `subject:${subject}`];
      const newMeta = { ...meta, tags: newTags };
      const newRaw = serializeFrontmatter(newMeta, body);
      writeFileSync(filePath, newRaw, "utf-8");
      updated++;
      console.log(`  [${type}] ${subject} ← ${basename(filePath)}`);
    } catch (e) {
      console.error(`  ERROR ${basename(filePath)}:`, e);
    }
  }

  console.log(`\nDone: ${updated} updated, ${alreadyHas} already had subject, ${skipped} skipped (non-L1)`);
}

const groupArg = process.argv[2];
if (!groupArg) {
  console.error("Usage: npx tsx scripts/backfill-subject-tags.ts <group-name>");
  console.error("  e.g.: npx tsx scripts/backfill-subject-tags.ts dingtalk-shog");
  process.exit(1);
}

const repoRoot = join(new URL(".", import.meta.url).pathname, "..");
const groupDir = join(repoRoot, "groups", groupArg);

if (!existsSync(groupDir)) {
  console.error(`Group dir not found: ${groupDir}`);
  process.exit(1);
}

console.log(`Backfilling subject tags for group: ${groupDir}\n`);
backfillSubjectTags(groupDir);
