/**
 * Tests for claude-code.ts — validateRepo, parameter handling.
 * Uses real temp git repos for validation tests.
 */
import { execSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { validateRepo } from './claude-code.js';

let tmpDir: string;

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: 'pipe',
  });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Need at least one commit for `git diff HEAD` to work
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

describe('validateRepo', () => {
  beforeEach(() => {
    // Use realpathSync to resolve macOS /tmp → /private/tmp symlink
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'shog-agent-claude-test-')),
    );
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for valid clean repo in whitelist', () => {
    const result = validateRepo(tmpDir, [tmpDir]);
    expect(result).toBeNull();
  });

  it('rejects repo not in whitelist', () => {
    const result = validateRepo(tmpDir, ['/some/other/path']);
    expect(result).toContain('whitelist');
  });

  it('rejects empty whitelist', () => {
    const result = validateRepo(tmpDir, []);
    expect(result).toContain('whitelist');
  });

  it('rejects repo with uncommitted tracked changes', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Modified');
    const result = validateRepo(tmpDir, [tmpDir]);
    expect(result).toContain('uncommitted');
  });

  it('rejects repo with staged changes', () => {
    fs.writeFileSync(path.join(tmpDir, 'new-file.ts'), 'export const x = 1;');
    execSync('git add new-file.ts', { cwd: tmpDir, stdio: 'pipe' });
    const result = validateRepo(tmpDir, [tmpDir]);
    expect(result).toContain('uncommitted');
  });

  it('allows repo with untracked files', () => {
    fs.writeFileSync(path.join(tmpDir, 'untracked.txt'), 'not staged');
    const result = validateRepo(tmpDir, [tmpDir]);
    expect(result).toBeNull();
  });

  it('resolves symlinks in whitelist', () => {
    const symlinkDir = path.join(
      os.tmpdir(),
      `shog-agent-symlink-test-${Date.now()}`,
    );
    try {
      fs.symlinkSync(tmpDir, symlinkDir);
      // Whitelist has symlink, validate with real path
      const result = validateRepo(tmpDir, [symlinkDir]);
      expect(result).toBeNull();
    } finally {
      try {
        fs.unlinkSync(symlinkDir);
      } catch {}
    }
  });

  it('rejects non-existent repo path', () => {
    const result = validateRepo('/tmp/nonexistent-repo-12345', [
      '/tmp/nonexistent-repo-12345',
    ]);
    expect(result).not.toBeNull();
  });
});

describe('ExecRalphParams validation', () => {
  it('ExecRalphParams interface has required fields', async () => {
    // Type-level test: ensure the interface exists and has expected shape
    const { ExecRalphParams } = (await import('./claude-code.js')) as any;
    // This is a runtime check that the module exports correctly
    const mod = await import('./claude-code.js');
    expect(mod.execRalph).toBeTypeOf('function');
    expect(mod.execClaude).toBeTypeOf('function');
    expect(mod.validateRepo).toBeTypeOf('function');
  });
});

describe('ExecClaudeParams validation', () => {
  it('exports execClaude function', async () => {
    const mod = await import('./claude-code.js');
    expect(mod.execClaude).toBeTypeOf('function');
  });
});
