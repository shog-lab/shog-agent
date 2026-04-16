/**
 * Claude Code execution on the host machine.
 *
 * Two modes:
 * - execRalph: runs ralph.sh (Claude Code in a loop) in an isolated worktree
 * - execClaude: runs `claude -p` directly in the repo (one-shot, no branch)
 *
 * Safety:
 * - Repo must be in codeRepos whitelist
 * - execRalph: refuses dirty working tree, uses git worktree isolation
 * - execClaude: read-only by default (just runs a prompt, no git changes)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { ErrorCode, makeError, type ExecResult } from './errors.js';
import {
  ensureBranch,
  createWorktree,
  removeWorktree,
} from './git-worktree.js';
import { logger } from './logger.js';
import { evaluateRalphRisk, evaluateClaudeRisk } from './risk-scorer.js';
import { spawnAndCapture } from './spawn-utils.js';
import {
  getDirectModeTools,
  getWorktreeModeDisallowedTools,
} from './verify-command.js';

// Re-export for backward compatibility
export type { ExecResult } from './errors.js';

function writeResponse(responseFile: string | null, result: ExecResult): void {
  if (!responseFile) return;
  const tempFile = `${responseFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(result));
  fs.renameSync(tempFile, responseFile);
}

/**
 * Validate repo: must be in whitelist and have clean working tree.
 * Shared by execRalph and execClaude.
 */
export function validateRepo(
  resolvedRepo: string,
  allowedRepos: string[],
): string | null {
  const isAllowed = allowedRepos.some((r: string) => {
    try {
      return fs.realpathSync(r) === resolvedRepo;
    } catch {
      return false;
    }
  });
  if (!isAllowed) {
    return `repo not in codeRepos whitelist: ${resolvedRepo}`;
  }

  try {
    // Only check tracked files — untracked files don't affect git operations
    const gitStatus = execSync('git diff --stat HEAD', {
      cwd: resolvedRepo,
      encoding: 'utf-8',
    }).trim();
    const stagedStatus = execSync('git diff --cached --stat', {
      cwd: resolvedRepo,
      encoding: 'utf-8',
    }).trim();
    if (gitStatus || stagedStatus) {
      return `BLOCKED: repo has uncommitted changes. Commit or stash first.\n\n${gitStatus}\n${stagedStatus}`;
    }
  } catch (err) {
    return `failed to check git status: ${err}`;
  }

  return null;
}

// --- execRalph ---

export interface ExecRalphParams {
  repo: string;
  feature: string;
  iterations: number;
  prdPath?: string;
  context?: string;
  sourceGroup: string;
  responseFile: string | null;
  timeout?: number; // ms, default 60 min
  riskThreshold?: number; // from GovernanceConfig, default 15
}

/**
 * Execute Ralph in an isolated git worktree. Async — returns immediately,
 * writes result to responseFile when done.
 */
export function execRalph(params: ExecRalphParams): void {
  const {
    repo,
    feature,
    iterations,
    prdPath,
    context,
    sourceGroup,
    responseFile,
    timeout: ralphTimeout = 60 * 60 * 1000,
  } = params;

  const resolvedRepo = fs.existsSync(repo) ? fs.realpathSync(repo) : repo;

  // Risk assessment — block if risk too high
  const riskWarning = evaluateRalphRisk({
    feature,
    iterations,
    hasPrd: !!prdPath,
    riskThreshold: params.riskThreshold,
  });
  if (riskWarning) {
    logger.warn({ riskWarning }, 'exec_ralph: blocked by risk assessment');
    writeResponse(responseFile, makeError(ErrorCode.PERMISSION, riskWarning));
    return;
  }

  // Ralph-specific: ralph.sh must exist
  const ralphScript = path.join(resolvedRepo, 'scripts', 'ralph', 'ralph.sh');
  if (!fs.existsSync(ralphScript)) {
    writeResponse(
      responseFile,
      makeError(ErrorCode.VALIDATION, `ralph.sh not found at ${ralphScript}`),
    );
    return;
  }

  const branchName = `ralph/${feature}`;
  const worktreeDir = path.join(
    resolvedRepo,
    '..',
    `.ralph-worktree-${feature}`,
  );

  logger.info(
    { repo: resolvedRepo, feature, branch: branchName, iterations },
    'exec_ralph: starting',
  );

  (async () => {
    try {
      ensureBranch(resolvedRepo, branchName);
      createWorktree(resolvedRepo, worktreeDir, branchName);

      // Copy prd.json into worktree
      if (prdPath) {
        const relativePrd = prdPath.replace(/^\/workspace\/group\//, '');
        const hostPrdPath = path.join(GROUPS_DIR, sourceGroup, relativePrd);
        if (fs.existsSync(hostPrdPath)) {
          fs.copyFileSync(hostPrdPath, path.join(worktreeDir, 'prd.json'));
          logger.info({ hostPrdPath }, 'exec_ralph: copied prd.json');
        }
      }

      // Inject task context into CLAUDE.md
      if (context) {
        const wtClaudeMd = path.join(worktreeDir, 'CLAUDE.md');
        const existing = fs.existsSync(wtClaudeMd)
          ? fs.readFileSync(wtClaudeMd, 'utf-8')
          : '';
        fs.writeFileSync(
          wtClaudeMd,
          existing +
            `\n\n## Current Task Context (injected by ShogAgent)\n\n${context}\n`,
        );
      }

      const wtRalphScript = path.join(
        worktreeDir,
        'scripts',
        'ralph',
        'ralph.sh',
      );
      const result = await spawnAndCapture(
        'bash',
        [wtRalphScript, '--tool', 'claude', String(iterations)],
        {
          cwd: worktreeDir,
          timeout: ralphTimeout,
          maxOutputChars: 5000,
        },
      );

      logger.info(
        { repo: resolvedRepo, feature, status: result.status },
        'exec_ralph: completed',
      );
      removeWorktree(resolvedRepo, worktreeDir);
      writeResponse(responseFile, result);
    } catch (err) {
      logger.error({ err, repo: resolvedRepo, feature }, 'exec_ralph: failed');
      removeWorktree(resolvedRepo, worktreeDir);
      writeResponse(responseFile, makeError(ErrorCode.EXECUTION, String(err)));
    }
  })();
}

// --- execClaude ---

export interface ExecClaudeParams {
  repo: string;
  prompt: string;
  branch?: string; // Optional: run on this branch in a worktree
  useWorktree?: boolean; // Default true. Set false to run directly in repo (for black box testing)
  sourceGroup?: string; // Group folder name, used to resolve artifacts dir
  responseFile: string | null;
  timeout?: number; // ms, default 30 min
  riskThreshold?: number; // from GovernanceConfig, default 15
}

/**
 * Run `claude -p` on a repo. Two modes:
 * - useWorktree=true (default): isolated git worktree, safe for code review
 * - useWorktree=false: runs directly in repo directory, for black box testing
 * Async — returns immediately, writes result to responseFile when done.
 */
export function execClaude(params: ExecClaudeParams): void {
  const {
    repo,
    prompt,
    branch,
    useWorktree = true,
    responseFile,
    timeout = 30 * 60 * 1000,
  } = params;

  const resolvedRepo = fs.existsSync(repo) ? fs.realpathSync(repo) : repo;

  // Risk assessment — block if risk too high
  const riskWarning = evaluateClaudeRisk({
    useWorktree: useWorktree ?? true,
    promptLength: prompt.length,
    riskThreshold: params.riskThreshold,
  });
  if (riskWarning) {
    logger.warn({ riskWarning }, 'exec_claude: blocked by risk assessment');
    writeResponse(responseFile, makeError(ErrorCode.PERMISSION, riskWarning));
    return;
  }

  // Direct mode: run in repo directory, no worktree
  if (!useWorktree) {
    // Set up artifacts directory for screenshots etc.
    const artifactsDir = params.sourceGroup
      ? path.join(GROUPS_DIR, params.sourceGroup, 'artifacts')
      : path.join(resolvedRepo, '..', '.claude-artifacts');

    // Clean artifacts from previous run
    if (fs.existsSync(artifactsDir)) {
      for (const f of fs.readdirSync(artifactsDir)) {
        try {
          fs.unlinkSync(path.join(artifactsDir, f));
        } catch {
          /* ignore */
        }
      }
    }
    fs.mkdirSync(artifactsDir, { recursive: true });

    // Append artifacts instruction to prompt
    const fullPrompt = `${prompt}\n\n[SYSTEM] 截图和生成的文件必须保存到 ${artifactsDir}，不要保存到 repo 目录。`;

    logger.info(
      { repo: resolvedRepo, artifactsDir, promptLength: prompt.length },
      'exec_claude: starting (direct mode)',
    );

    (async () => {
      try {
        const result = await spawnAndCapture(
          'claude',
          [
            '-p',
            fullPrompt,
            '--allowedTools',
            ...getDirectModeTools(),
            '--dangerously-skip-permissions',
          ],
          { cwd: resolvedRepo, timeout },
        );

        logger.info(
          { repo: resolvedRepo, status: result.status },
          'exec_claude: completed (direct)',
        );
        writeResponse(responseFile, result);
      } catch (err) {
        logger.error(
          { err, repo: resolvedRepo },
          'exec_claude: failed (direct)',
        );
        writeResponse(
          responseFile,
          makeError(ErrorCode.EXECUTION, String(err)),
        );
      }
    })();
    return;
  }

  // Worktree mode
  const worktreeId = `claude-${Date.now()}`;
  const worktreeDir = path.join(
    resolvedRepo,
    '..',
    `.claude-worktree-${worktreeId}`,
  );

  logger.info(
    { repo: resolvedRepo, branch, promptLength: prompt.length },
    'exec_claude: starting (worktree mode)',
  );

  (async () => {
    try {
      createWorktree(resolvedRepo, worktreeDir, branch || 'HEAD');

      const result = await spawnAndCapture(
        'claude',
        [
          '-p',
          prompt,
          '--disallowedTools',
          ...getWorktreeModeDisallowedTools(),
          '--dangerously-skip-permissions',
        ],
        { cwd: worktreeDir, timeout },
      );

      logger.info(
        { repo: resolvedRepo, status: result.status },
        'exec_claude: completed',
      );
      removeWorktree(resolvedRepo, worktreeDir);
      writeResponse(responseFile, result);
    } catch (err) {
      logger.error({ err, repo: resolvedRepo }, 'exec_claude: failed');
      removeWorktree(resolvedRepo, worktreeDir);
      writeResponse(responseFile, makeError(ErrorCode.EXECUTION, String(err)));
    }
  })();
}
