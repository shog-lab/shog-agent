/**
 * One-time migration: memory/ + llm-wiki/ → wiki/ + raw/ + schema/
 * Run: npx tsx scripts/migrate-to-wiki.ts
 */
import fs from "node:fs";
import path from "node:path";

// Inline helpers (core.ts can't be imported directly due to tsconfig mismatch)
interface Frontmatter { [key: string]: string | string[] | undefined; }

function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const meta: Frontmatter = {};
  if (!raw.startsWith("---")) return { meta, body: raw };
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return { meta, body: raw };
  const yamlBlock = raw.slice(4, endIdx);
  const body = raw.slice(endIdx + 4).replace(/^\n+/, "");
  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      meta[key] = rawValue.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      meta[key] = rawValue;
    }
  }
  return { meta, body };
}

function getMemoryType(tags: string, fallbackType: string): string {
  if (tags) {
    for (const tag of tags.split(",")) {
      const trimmed = tag.trim();
      if (trimmed.startsWith("memory-type:")) {
        return trimmed.slice("memory-type:".length);
      }
    }
  }
  return fallbackType || "note";
}

const TYPE_SUBDIR: Record<string, string> = {
  preference: "facts",
  decision: "facts",
  fact: "facts",
  compaction: "compaction",
  research: "knowledge",
  workflow: "knowledge",
  note: "knowledge",
};

function collectMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectMdFiles(full));
    else if (entry.name.endsWith(".md")) results.push(full);
  }
  return results;
}

const groupsDir = path.resolve(import.meta.dirname!, "..", "groups");
const groups = fs.readdirSync(groupsDir).filter((g) =>
  fs.statSync(path.join(groupsDir, g)).isDirectory(),
);

for (const g of groups) {
  const groupDir = path.join(groupsDir, g);
  console.log(`\n=== ${g} ===`);

  // Create wiki structure
  for (const sub of ["facts", "knowledge", "compaction"]) {
    fs.mkdirSync(path.join(groupDir, "wiki", sub), { recursive: true });
  }
  fs.mkdirSync(path.join(groupDir, "raw"), { recursive: true });
  fs.mkdirSync(path.join(groupDir, "schema"), { recursive: true });

  // 1. Migrate memory/ → wiki/{subdir}/
  const memDir = path.join(groupDir, "memory");
  if (fs.existsSync(memDir)) {
    const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
    let moved = 0;
    for (const file of files) {
      const src = path.join(memDir, file);
      try {
        const raw = fs.readFileSync(src, "utf-8");
        const { meta } = parseFrontmatter(raw);
        const tags = Array.isArray(meta.tags) ? meta.tags.join(",") : "";
        const memType = getMemoryType(tags, (meta.type as string) || "note");
        const subdir = TYPE_SUBDIR[memType] || "knowledge";
        const dest = path.join(groupDir, "wiki", subdir, file);
        if (!fs.existsSync(dest)) {
          fs.renameSync(src, dest);
          console.log(`  ${file} → wiki/${subdir}/`);
          moved++;
        }
      } catch (err) {
        console.log(`  SKIP ${file}: ${err}`);
      }
    }
    console.log(`  memory/: moved ${moved}/${files.length}`);
  }

  // 2. Migrate llm-wiki/ → wiki/, raw/, schema/
  const llmWikiDir = path.join(groupDir, "llm-wiki");
  if (fs.existsSync(llmWikiDir)) {
    // wiki/ contents
    const wikiSrc = path.join(llmWikiDir, "wiki");
    if (fs.existsSync(wikiSrc)) {
      const wikiFiles = collectMdFiles(wikiSrc);
      let moved = 0;
      for (const file of wikiFiles) {
        const rel = path.relative(wikiSrc, file);
        const dest = path.join(groupDir, "wiki", rel);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(file, dest);
          moved++;
        }
      }
      console.log(`  llm-wiki/wiki/: moved ${moved}`);
    }

    // raw/ contents
    const rawSrc = path.join(llmWikiDir, "raw");
    if (fs.existsSync(rawSrc)) {
      const rawFiles = collectMdFiles(rawSrc);
      let moved = 0;
      for (const file of rawFiles) {
        const rel = path.relative(rawSrc, file);
        const dest = path.join(groupDir, "raw", rel);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(file, dest);
          moved++;
        }
      }
      console.log(`  llm-wiki/raw/: moved ${moved}`);
    }

    // schema/ contents
    const schemaSrc = path.join(llmWikiDir, "schema");
    if (fs.existsSync(schemaSrc)) {
      const schemaFiles = collectMdFiles(schemaSrc);
      let moved = 0;
      for (const file of schemaFiles) {
        const rel = path.relative(schemaSrc, file);
        const dest = path.join(groupDir, "schema", rel);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(file, dest);
          moved++;
        }
      }
      console.log(`  llm-wiki/schema/: moved ${moved}`);
    }
  }
}

console.log("\n=== Done ===");
