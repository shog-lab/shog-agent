import { execSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  ensureBranch,
  createWorktree,
  removeWorktree,
} from './git-worktree.js';

let repoDir: string;

function initRepo(): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', {
    cwd: repoDir,
    stdio: 'pipe',
  });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test');
  execSync('git add . && git commit -m "init"', {
    cwd: repoDir,
    stdio: 'pipe',
  });
}

describe('ensureBranch', () => {
  beforeEach(() => {
    repoDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'shog-agent-wt-test-')),
    );
    initRepo();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('creates a new branch', () => {
    ensureBranch(repoDir, 'ralph/test-feature');
    const branches = execSync('git branch', {
      cwd: repoDir,
      encoding: 'utf-8',
    });
    expect(branches).toContain('ralph/test-feature');
  });

  it('reuses existing branch without error', () => {
    execSync('git branch ralph/existing', { cwd: repoDir, stdio: 'pipe' });
    expect(() => ensureBranch(repoDir, 'ralph/existing')).not.toThrow();
  });
});

describe('createWorktree', () => {
  beforeEach(() => {
    repoDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'shog-agent-wt-test-')),
    );
    initRepo();
  });

  afterEach(() => {
    // Clean up worktrees first
    try {
      const worktrees = execSync('git worktree list --porcelain', {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      for (const line of worktrees.split('\n')) {
        if (line.startsWith('worktree ') && !line.includes(repoDir)) {
          const wtDir = line.slice('worktree '.length);
          try {
            execSync(`git worktree remove ${wtDir} --force`, {
              cwd: repoDir,
              stdio: 'pipe',
            });
          } catch {}
        }
      }
    } catch {}
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('creates worktree from branch', () => {
    execSync('git branch test-branch', { cwd: repoDir, stdio: 'pipe' });
    const wtDir = path.join(repoDir, '..', '.test-worktree');
    createWorktree(repoDir, wtDir, 'test-branch');
    expect(fs.existsSync(wtDir)).toBe(true);
    expect(fs.existsSync(path.join(wtDir, 'README.md'))).toBe(true);
    removeWorktree(repoDir, wtDir);
  });

  it('creates detached worktree from HEAD', () => {
    const wtDir = path.join(repoDir, '..', '.test-worktree-head');
    createWorktree(repoDir, wtDir, 'HEAD');
    expect(fs.existsSync(wtDir)).toBe(true);
    removeWorktree(repoDir, wtDir);
  });

  it('cleans up stale worktree before creating', () => {
    const wtDir = path.join(repoDir, '..', '.test-worktree-stale');
    execSync('git branch branch1', { cwd: repoDir, stdio: 'pipe' });
    createWorktree(repoDir, wtDir, 'branch1');
    // Create again — should clean up and recreate
    expect(() => createWorktree(repoDir, wtDir, 'branch1')).not.toThrow();
    removeWorktree(repoDir, wtDir);
  });
});

describe('removeWorktree', () => {
  beforeEach(() => {
    repoDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'shog-agent-wt-test-')),
    );
    initRepo();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('removes existing worktree', () => {
    const wtDir = path.join(repoDir, '..', '.test-worktree-rm');
    execSync('git branch rm-branch', { cwd: repoDir, stdio: 'pipe' });
    createWorktree(repoDir, wtDir, 'rm-branch');
    expect(fs.existsSync(wtDir)).toBe(true);
    removeWorktree(repoDir, wtDir);
    expect(fs.existsSync(wtDir)).toBe(false);
  });

  it('silently ignores non-existent worktree', () => {
    expect(() =>
      removeWorktree(repoDir, '/tmp/nonexistent-wt-12345'),
    ).not.toThrow();
  });
});
