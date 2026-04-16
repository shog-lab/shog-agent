/**
 * Tests for MemoryCore (container/extensions/memory/core.ts).
 * Uses temp directories for isolated testing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

const {
  MemoryCore,
  parseFrontmatter,
  serializeFrontmatter,
  extractLinks,
  estimateTokens,
  getMemoryType,
} =
  (await import('../container/extensions/memory/core.js')) as typeof import('../container/extensions/memory/core.js');

// --- Helper ---

let tmpDir: string;
let mc: InstanceType<typeof MemoryCore>;

function createCore(opts?: { freshDb?: boolean }) {
  return new MemoryCore({
    groupDir: tmpDir,
    dbPath: path.join(tmpDir, '.wiki-index.db'),
    freshDb: opts?.freshDb ?? true,
  });
}

function writeWikiFile(
  name: string,
  content: string,
  meta?: Record<string, string | string[]>,
) {
  const fullMeta = { date: '2026-04-15T00:00:00Z', type: 'note', ...meta };
  const raw = serializeFrontmatter(fullMeta as any, content);
  const filePath = path.join(tmpDir, 'wiki', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw);
  return filePath;
}

// --- Pure function tests ---

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const { meta, body } = parseFrontmatter(
      '---\ndate: 2026-01-01\ntype: fact\ntags: [a, b]\n---\n\nContent',
    );
    expect(meta.date).toBe('2026-01-01');
    expect(meta.type).toBe('fact');
    expect(meta.tags).toEqual(['a', 'b']);
    expect(body).toBe('Content');
  });

  it('returns raw content when no frontmatter', () => {
    const { meta, body } = parseFrontmatter('Just text');
    expect(Object.keys(meta).length).toBe(0);
    expect(body).toBe('Just text');
  });

  it('handles empty frontmatter', () => {
    const { meta, body } = parseFrontmatter('---\n---\n\nBody');
    expect(Object.keys(meta).length).toBe(0);
    expect(body).toBe('Body');
  });
});

describe('serializeFrontmatter', () => {
  it('produces valid frontmatter string', () => {
    const result = serializeFrontmatter(
      { date: '2026-01-01', type: 'fact', tags: ['a', 'b'] },
      'Content',
    );
    expect(result).toContain('---');
    expect(result).toContain('date: 2026-01-01');
    expect(result).toContain('tags: [a, b]');
    expect(result).toContain('Content');
  });

  it('roundtrips with parseFrontmatter', () => {
    const original = { date: '2026-01-01', type: 'note' };
    const serialized = serializeFrontmatter(original, 'Body text');
    const { meta, body } = parseFrontmatter(serialized);
    expect(meta.date).toBe('2026-01-01');
    expect(meta.type).toBe('note');
    expect(body).toBe('Body text');
  });
});

describe('extractLinks', () => {
  it('extracts [[links]] from content', () => {
    expect(extractLinks('See [[foo]] and [[bar]]')).toEqual(['foo', 'bar']);
  });

  it('returns empty for no links', () => {
    expect(extractLinks('No links here')).toEqual([]);
  });

  it('handles links with spaces', () => {
    expect(extractLinks('See [[agent memory]]')).toEqual(['agent memory']);
  });
});

describe('estimateTokens', () => {
  it('estimates roughly 1 token per 4 chars', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('a')).toBe(1);
  });
});

describe('getMemoryType', () => {
  it('extracts memory-type from tags', () => {
    expect(getMemoryType('topic1, memory-type:fact', 'note')).toBe('fact');
  });

  it('falls back to type parameter', () => {
    expect(getMemoryType('topic1, topic2', 'research')).toBe('research');
  });

  it('falls back to note when no type', () => {
    expect(getMemoryType('', '')).toBe('note');
  });
});

// --- MemoryCore tests ---

describe('MemoryCore', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shog-agent-test-'));
    mc = createCore();
  });

  afterEach(() => {
    mc.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('creates wiki/ and raw/ directories', () => {
      expect(fs.existsSync(path.join(tmpDir, 'wiki'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'wiki', 'compaction'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'raw'))).toBe(true);
    });

    it('creates .wiki-index.db', () => {
      expect(fs.existsSync(path.join(tmpDir, '.wiki-index.db'))).toBe(true);
    });
  });

  describe('saveMemory', () => {
    it('saves compaction to wiki/compaction/', () => {
      const fp = mc.saveMemory('compaction', 'Summary text');
      expect(fp).toContain('wiki/compaction/');
      expect(fs.existsSync(fp)).toBe(true);
    });

    it('saves other types to wiki/ root', () => {
      const fp = mc.saveMemory('fact', 'User likes dark mode');
      expect(fp).toContain('/wiki/');
      expect(fp).not.toContain('/compaction/');
      expect(fs.existsSync(fp)).toBe(true);
    });

    it('writes valid frontmatter', () => {
      const fp = mc.saveMemory('research', 'Findings', ['ai', 'memory']);
      const content = fs.readFileSync(fp, 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      expect(meta.type).toBe('research');
      expect(meta.tags).toEqual(['ai', 'memory']);
      expect(body).toBe('Findings');
    });
  });

  describe('syncIndex + searchFTS5', () => {
    it('indexes and searches wiki files', () => {
      writeWikiFile('test-search.md', 'Agent memory architecture overview');
      mc.syncIndex();
      const results = mc.searchFTS5('memory architecture');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].entry.content).toContain('memory');
    });

    it('indexes files from raw/ too', () => {
      const rawPath = path.join(tmpDir, 'raw', 'source.md');
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.writeFileSync(
        rawPath,
        '---\ndate: 2026-01-01\ntype: note\n---\n\nOriginal source material',
      );
      mc.syncIndex();
      const results = mc.searchFTS5('source material');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('removes deleted files from index', () => {
      const fp = writeWikiFile('to-delete.md', 'xylophone zebra unique phrase');
      mc.syncIndex();
      expect(mc.searchFTS5('xylophone zebra').length).toBeGreaterThanOrEqual(1);

      fs.unlinkSync(fp);
      mc.syncIndex();
      expect(mc.searchFTS5('xylophone zebra').length).toBe(0);
    });

    it('filters stopwords', () => {
      writeWikiFile('stopword-test.md', 'the quick brown fox');
      mc.syncIndex();
      // "the" is a stopword, should still find by "quick" or "brown"
      const results = mc.searchFTS5('quick brown');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('applies type weights to scores', () => {
      writeWikiFile('pref.md', 'User prefers dark mode always', {
        type: 'preference',
      });
      writeWikiFile('note.md', 'Note about dark mode settings', {
        type: 'note',
      });
      mc.syncIndex();
      const results = mc.searchFTS5('dark mode');
      expect(results.length).toBeGreaterThanOrEqual(2);
      const prefResult = results.find((r) => r.entry.type === 'preference');
      const noteResult = results.find((r) => r.entry.type === 'note');
      expect(prefResult).toBeDefined();
      expect(noteResult).toBeDefined();
      // preference weight (1.5) should give higher score than note (1.0)
      expect(prefResult!.score).toBeGreaterThan(noteResult!.score);
    });
  });

  describe('loadL1', () => {
    it('loads fact/preference/decision types', () => {
      writeWikiFile('fact1.md', 'User name is Alice', { type: 'fact' });
      writeWikiFile('pref1.md', 'Prefers dark mode', { type: 'preference' });
      writeWikiFile('note1.md', 'Random note', { type: 'note' });
      const l1 = mc.loadL1();
      expect(l1.length).toBe(2); // fact + preference, not note
      const types = l1.map((e) => e.type);
      expect(types).toContain('fact');
      expect(types).toContain('preference');
      expect(types).not.toContain('note');
    });

    it('scans recursively (compaction/ subdirectory)', () => {
      // compaction files should not be L1 (type=compaction is not in L1_TYPES)
      mc.saveMemory('compaction', 'A conversation summary');
      const l1 = mc.loadL1();
      expect(l1.every((e) => e.type !== 'compaction')).toBe(true);
    });
  });

  describe('auto-heal frontmatter', () => {
    it('adds frontmatter to files without it', () => {
      const fp = path.join(tmpDir, 'wiki', 'no-frontmatter.md');
      fs.writeFileSync(fp, 'Just plain text, no frontmatter');
      mc.syncIndex();
      const healed = fs.readFileSync(fp, 'utf-8');
      expect(healed.startsWith('---')).toBe(true);
      const { meta } = parseFrontmatter(healed);
      expect(meta.type).toBe('note');
      expect(meta.tags).toContain('auto-healed');
    });

    it('adds missing type field', () => {
      const fp = path.join(tmpDir, 'wiki', 'no-type.md');
      fs.writeFileSync(
        fp,
        '---\ndate: 2026-01-01\n---\n\nContent without type',
      );
      mc.syncIndex();
      const healed = fs.readFileSync(fp, 'utf-8');
      const { meta } = parseFrontmatter(healed);
      expect(meta.type).toBe('note');
    });

    it('adds missing date field', () => {
      const fp = path.join(tmpDir, 'wiki', 'no-date.md');
      fs.writeFileSync(fp, '---\ntype: fact\n---\n\nContent without date');
      mc.syncIndex();
      const healed = fs.readFileSync(fp, 'utf-8');
      const { meta } = parseFrontmatter(healed);
      expect(meta.date).toBeTruthy();
    });
  });

  describe('[[link]] resolution', () => {
    it('resolves exact slug match', () => {
      writeWikiFile('agent-memory.md', 'About agent memory');
      mc.syncIndex();
      const resolved = mc.resolveLink('agent-memory');
      expect(resolved).not.toBeNull();
      expect(resolved).toContain('agent-memory.md');
    });

    it('resolves linked content', () => {
      writeWikiFile('page-a.md', 'See [[page-b]] for more');
      writeWikiFile('page-b.md', 'Linked page content here');
      mc.syncIndex();
      const linked = mc.resolveLinkedContent('See [[page-b]] for more');
      expect(linked.length).toBe(1);
      expect(linked[0].content).toContain('Linked page content');
    });

    it('returns empty for broken links', () => {
      mc.syncIndex();
      expect(mc.resolveLink('nonexistent')).toBeNull();
    });
  });

  describe('generateIndex', () => {
    it('auto-generates wiki/index.md', () => {
      writeWikiFile('foo.md', 'Foo content');
      writeWikiFile('bar.md', 'Bar content');
      mc.syncIndex();
      const indexPath = path.join(tmpDir, 'wiki', 'index.md');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf-8');
      expect(content).toContain('[[foo]]');
      expect(content).toContain('[[bar]]');
    });
  });

  describe('buildContext', () => {
    it('includes L1 memories', async () => {
      writeWikiFile('fact.md', 'User is a developer', { type: 'fact' });
      mc.syncIndex();
      const ctx = await mc.buildContext('anything');
      expect(ctx).toContain('critical-memory');
      expect(ctx).toContain('developer');
    });

    it('includes search results', async () => {
      writeWikiFile(
        'research.md',
        'Agent memory survey findings on retrieval',
        { type: 'research' },
      );
      mc.syncIndex();
      const ctx = await mc.buildContext('memory retrieval');
      expect(ctx).toContain('long-term-memory');
      expect(ctx).toContain('retrieval');
    });

    it('includes KG when entities match', async () => {
      mc.kg.addTriple('Alice', 'works_at', 'CompanyX');
      writeWikiFile('dummy.md', 'Placeholder');
      mc.syncIndex();
      const ctx = await mc.buildContext('What does Alice do');
      expect(ctx).toContain('knowledge-graph');
      expect(ctx).toContain('CompanyX');
    });
  });

  describe('buildKGContext', () => {
    it('delegates to kg.buildContext', () => {
      mc.kg.addTriple('Bob', 'likes', 'Coffee');
      const ctx = mc.buildKGContext('Tell me about Bob');
      expect(ctx).toContain('Coffee');
    });
  });

  describe('legacy migration', () => {
    it('migrates memory/ files to wiki/', () => {
      // Create legacy memory dir with files
      const legacyDir = path.join(tmpDir, 'memory');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'old-fact.md'),
        '---\ndate: 2026-01-01\ntype: fact\n---\n\nOld fact',
      );
      fs.writeFileSync(
        path.join(legacyDir, 'old-note.md'),
        '---\ndate: 2026-01-01\ntype: note\n---\n\nOld note',
      );

      // Create new core with legacy migration
      const mc2 = new MemoryCore({
        groupDir: tmpDir,
        dbPath: path.join(tmpDir, '.wiki-index2.db'),
        freshDb: true,
        legacyMemoryDir: legacyDir,
      });

      // After flattening, non-compaction types go to wiki/ root
      expect(fs.existsSync(path.join(tmpDir, 'wiki', 'old-fact.md'))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(tmpDir, 'wiki', 'old-note.md'))).toBe(
        true,
      );

      mc2.close();
    });
  });
});
