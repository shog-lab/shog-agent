/**
 * Git worktree lifecycle management.
 * Replaces duplicated worktree create/reuse/cleanup in claude-code.ts.
 */

import { execSync } from 'child_process';
import { logger } from './logger.js';

/** Create a branch if it doesn't exist, reuse if it does */
export function ensureBranch(repo: string, branchName: string): void {
  try {
    execSync(`git rev-parse --verify ${branchName}`, {
      cwd: repo,
      stdio: 'pipe',
    });
    logger.info({ branch: branchName }, 'git: reusing existing branch');
  } catch {
    execSync(`git branch ${branchName} HEAD`, { cwd: repo, stdio: 'pipe' });
    logger.info({ branch: branchName }, 'git: created new branch');
  }
}

/** Create a worktree, cleaning up stale one if exists */
export function createWorktree(
  repo: string,
  worktreeDir: string,
  target: string | 'HEAD',
): void {
  // Clean up stale worktree if exists
  try {
    execSync(`git worktree remove ${worktreeDir} --force`, {
      cwd: repo,
      stdio: 'pipe',
    });
  } catch {
    /* doesn't exist, fine */
  }

  if (target === 'HEAD') {
    execSync(`git worktree add --detach ${worktreeDir} HEAD`, {
      cwd: repo,
      stdio: 'pipe',
    });
  } else {
    execSync(`git worktree add ${worktreeDir} ${target}`, {
      cwd: repo,
      stdio: 'pipe',
    });
  }
  logger.info({ worktreeDir, target }, 'git: worktree created');
}

/** Remove a worktree (silently ignores if it doesn't exist) */
export function removeWorktree(repo: string, worktreeDir: string): void {
  try {
    execSync(`git worktree remove ${worktreeDir} --force`, {
      cwd: repo,
      stdio: 'pipe',
    });
  } catch {
    /* ignore */
  }
}
