/**
 * IPC integration tests for exec_ralph and exec_claude.
 *
 * Tests the full flow: processTaskIpc receives IPC data →
 * validates repo → delegates to exec functions → writes response file.
 *
 * Uses real temp git repos but mocks the actual Claude Code / Ralph execution
 * (we don't want to spawn real claude processes in tests).
 */
import { execSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { processTaskIpc, type IpcDeps } from '../src/ipc.js';

// Mock claude-code to avoid spawning real processes
vi.mock('../src/claude-code.js', async () => {
  const actual = (await vi.importActual('../src/claude-code.js')) as any;
  return {
    ...actual,
    // Keep validateRepo real — it tests actual git operations
    // Mock execRalph and execClaude to write response immediately
    execRalph: vi.fn((params: any) => {
      if (params.responseFile) {
        const tempFile = `${params.responseFile}.tmp`;
        fs.writeFileSync(
          tempFile,
          JSON.stringify({ status: 'success', output: 'mock ralph done' }),
        );
        fs.renameSync(tempFile, params.responseFile);
      }
    }),
    execClaude: vi.fn((params: any) => {
      if (params.responseFile) {
        const tempFile = `${params.responseFile}.tmp`;
        fs.writeFileSync(
          tempFile,
          JSON.stringify({ status: 'success', output: 'mock claude done' }),
        );
        fs.renameSync(tempFile, params.responseFile);
      }
    }),
  };
});

let tmpDir: string;
let repoDir: string;
let dataDir: string;

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: 'pipe',
  });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  // Create ralph.sh for exec_ralph validation
  fs.mkdirSync(path.join(dir, 'scripts', 'ralph'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'scripts', 'ralph', 'ralph.sh'),
    '#!/bin/bash\necho "mock ralph"',
  );
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

function makeDeps(overrides?: Partial<IpcDeps>): IpcDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: () => ({
      'dt:test-jid': {
        name: 'test-group',
        folder: 'test-group',
        trigger: '@test',
        added_at: new Date().toISOString(),
        containerConfig: {
          codeRepos: [repoDir],
        },
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    ...overrides,
  };
}

describe('IPC exec_ralph integration', () => {
  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'shog-agent-ipc-test-')),
    );
    repoDir = path.join(tmpDir, 'repo');
    dataDir = path.join(tmpDir, 'data');
    initGitRepo(repoDir);
    // Set DATA_DIR for response file paths
    process.env.SHOGCLAW_DATA_DIR = dataDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SHOGCLAW_DATA_DIR;
    vi.clearAllMocks();
  });

  it('rejects exec_ralph without repo', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      { type: 'exec_ralph', feature: 'test' },
      'test-group',
      false,
      deps,
    );
    // Should log warning and not call execRalph
    const { execRalph } = await import('../src/claude-code.js');
    expect(execRalph).not.toHaveBeenCalled();
  });

  it('rejects exec_ralph without feature', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      { type: 'exec_ralph', repo: repoDir },
      'test-group',
      false,
      deps,
    );
    const { execRalph } = await import('../src/claude-code.js');
    expect(execRalph).not.toHaveBeenCalled();
  });

  it('rejects exec_ralph for repo not in whitelist', async () => {
    const deps = makeDeps({
      registeredGroups: () => ({
        'dt:test-jid': {
          name: 'test-group',
          folder: 'test-group',
          trigger: '@test',
          added_at: new Date().toISOString(),
          containerConfig: { codeRepos: ['/some/other/path'] },
        },
      }),
    });

    await processTaskIpc(
      {
        type: 'exec_ralph',
        repo: repoDir,
        feature: 'test',
        requestId: 'req-1',
      },
      'test-group',
      false,
      deps,
    );

    const { execRalph } = await import('../src/claude-code.js');
    expect(execRalph).not.toHaveBeenCalled();
  });

  it('rejects exec_ralph with dirty repo', async () => {
    // Make repo dirty
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Modified');

    const deps = makeDeps();
    await processTaskIpc(
      {
        type: 'exec_ralph',
        repo: repoDir,
        feature: 'test',
        requestId: 'req-2',
      },
      'test-group',
      false,
      deps,
    );

    const { execRalph } = await import('../src/claude-code.js');
    expect(execRalph).not.toHaveBeenCalled();
  });

  it('calls execRalph for valid request', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      {
        type: 'exec_ralph',
        repo: repoDir,
        feature: 'test-feature',
        requestId: 'req-3',
        iterations: 5,
      },
      'test-group',
      false,
      deps,
    );

    const { execRalph } = await import('../src/claude-code.js');
    expect(execRalph).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: repoDir,
        feature: 'test-feature',
        iterations: 5,
      }),
    );
  });

  it('caps iterations at governance maxIterations', async () => {
    const deps = makeDeps({
      registeredGroups: () => ({
        'dt:test-jid': {
          name: 'test-group',
          folder: 'test-group',
          trigger: '@test',
          added_at: new Date().toISOString(),
          containerConfig: {
            codeRepos: [repoDir],
            governance: { maxIterations: 5 },
          },
        },
      }),
    });

    await processTaskIpc(
      {
        type: 'exec_ralph',
        repo: repoDir,
        feature: 'test',
        requestId: 'req-4',
        iterations: 100,
      },
      'test-group',
      false,
      deps,
    );

    const { execRalph } = await import('../src/claude-code.js');
    expect(execRalph).toHaveBeenCalledWith(
      expect.objectContaining({ iterations: 5 }),
    );
  });
});

describe('IPC exec_claude integration', () => {
  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'shog-agent-ipc-test-')),
    );
    repoDir = path.join(tmpDir, 'repo');
    dataDir = path.join(tmpDir, 'data');
    initGitRepo(repoDir);
    process.env.SHOGCLAW_DATA_DIR = dataDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SHOGCLAW_DATA_DIR;
    vi.clearAllMocks();
  });

  it('rejects exec_claude without repo', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      { type: 'exec_claude', prompt: 'test' },
      'test-group',
      false,
      deps,
    );
    const { execClaude } = await import('../src/claude-code.js');
    expect(execClaude).not.toHaveBeenCalled();
  });

  it('rejects exec_claude without prompt', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      { type: 'exec_claude', repo: repoDir },
      'test-group',
      false,
      deps,
    );
    const { execClaude } = await import('../src/claude-code.js');
    expect(execClaude).not.toHaveBeenCalled();
  });

  it('calls execClaude for valid request', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      {
        type: 'exec_claude',
        repo: repoDir,
        prompt: 'test prompt',
        requestId: 'req-5',
      },
      'test-group',
      false,
      deps,
    );

    const { execClaude } = await import('../src/claude-code.js');
    expect(execClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: repoDir,
        prompt: 'test prompt',
      }),
    );
  });

  it('passes branch and useWorktree params', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      {
        type: 'exec_claude',
        repo: repoDir,
        prompt: 'review code',
        requestId: 'req-6',
        branch: 'ralph/feature',
        useWorktree: false,
      },
      'test-group',
      false,
      deps,
    );

    const { execClaude } = await import('../src/claude-code.js');
    expect(execClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'ralph/feature',
        useWorktree: false,
      }),
    );
  });

  it('passes governance timeout', async () => {
    const deps = makeDeps({
      registeredGroups: () => ({
        'dt:test-jid': {
          name: 'test-group',
          folder: 'test-group',
          trigger: '@test',
          added_at: new Date().toISOString(),
          containerConfig: {
            codeRepos: [repoDir],
            governance: { claudeTimeoutMinutes: 15 },
          },
        },
      }),
    });

    await processTaskIpc(
      {
        type: 'exec_claude',
        repo: repoDir,
        prompt: 'test',
        requestId: 'req-7',
      },
      'test-group',
      false,
      deps,
    );

    const { execClaude } = await import('../src/claude-code.js');
    expect(execClaude).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 15 * 60 * 1000 }),
    );
  });
});
