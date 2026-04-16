/**
 * Risk scorer — 4-axis risk assessment for operations on repos.
 *
 * Axes (1-5 each, total 4-20):
 *   1. tool_risk      — inherent risk of the operation
 *   2. file_sensitivity — sensitivity of target files
 *   3. impact_scope    — breadth of potential impact
 *   4. reversibility   — how hard to undo
 *
 * Levels:
 *   LOW    (4-8)   — proceed silently
 *   MEDIUM (9-14)  — log warning
 *   HIGH   (15-20) — block execution
 *
 * Used by exec_ralph to evaluate risk before execution.
 */

export interface RiskScore {
  toolRisk: number;
  fileSensitivity: number;
  impactScope: number;
  reversibility: number;
  total: number;
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  summary: string;
}

// --- File sensitivity patterns ---

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; score: number }> = [
  // Critical — never touch
  { pattern: /\.env($|\.)/, score: 5 },
  { pattern: /credentials|secrets|tokens/i, score: 5 },
  { pattern: /id_rsa|\.pem$|\.key$/, score: 5 },

  // High — config and CI
  { pattern: /package\.json$/, score: 4 },
  { pattern: /pnpm-lock\.yaml$|package-lock\.json$|yarn\.lock$/, score: 4 },
  { pattern: /\.github\/|\.gitlab-ci|Jenkinsfile/, score: 4 },
  { pattern: /docker-compose|Dockerfile/, score: 3 },
  { pattern: /tsconfig|webpack|vite\.config|rollup/, score: 3 },

  // Medium — source code
  { pattern: /src\//, score: 2 },
  { pattern: /\.(ts|js|py|rs|go)$/, score: 2 },

  // Low — tests, docs
  { pattern: /test|spec|__test__/, score: 1 },
  { pattern: /\.md$|docs\//, score: 1 },
  { pattern: /\.txt$|\.log$/, score: 1 },
];

// --- Operation risk ---

const OPERATION_RISK: Record<string, number> = {
  // Read-only
  read: 1,
  search: 1,
  lint: 1,

  // Verification
  test: 2,
  typecheck: 2,
  build: 2,

  // Modification
  edit: 3,
  create: 3,
  install_dep: 4,

  // Destructive
  delete: 5,
  git_force: 5,
  exec_arbitrary: 4,
};

/**
 * Score the risk of a file path.
 */
function scoreFileSensitivity(filePath?: string): number {
  if (!filePath) return 2; // unknown file = medium
  for (const { pattern, score } of SENSITIVE_PATTERNS) {
    if (pattern.test(filePath)) return score;
  }
  return 2;
}

/**
 * Score the risk of an operation on a repo.
 */
export function scoreRisk(opts: {
  operation: string; // e.g. 'edit', 'delete', 'test', 'install_dep'
  filePath?: string; // target file if applicable
  affectsMultipleFiles?: boolean; // true if operation touches many files
  isReversible?: boolean; // can it be undone with git checkout?
}): RiskScore {
  const toolRisk = OPERATION_RISK[opts.operation] ?? 3;
  const fileSensitivity = scoreFileSensitivity(opts.filePath);
  const impactScope = opts.affectsMultipleFiles ? 4 : 2;
  const reversibility =
    opts.isReversible === false ? 4 : opts.isReversible === true ? 1 : 2;

  const total = toolRisk + fileSensitivity + impactScope + reversibility;
  const level = total <= 8 ? 'LOW' : total <= 14 ? 'MEDIUM' : 'HIGH';

  return {
    toolRisk,
    fileSensitivity,
    impactScope,
    reversibility,
    total,
    level,
    summary: `Risk ${total}/20 (${level}) — tool=${toolRisk} file=${fileSensitivity} scope=${impactScope} reversibility=${reversibility}`,
  };
}

/**
 * Evaluate risk of an exec_ralph operation.
 * Returns null if safe, error message if blocked.
 */
export function evaluateRalphRisk(opts: {
  feature: string;
  iterations: number;
  hasPrd: boolean;
  riskThreshold?: number;
}): string | null {
  const threshold = opts.riskThreshold ?? 15;

  // High iteration count = higher risk
  if (opts.iterations > 15) {
    const score = scoreRisk({
      operation: 'exec_arbitrary',
      affectsMultipleFiles: true,
      isReversible: true, // worktree isolation
    });
    if (score.total >= threshold) {
      return `Ralph with ${opts.iterations} iterations exceeds risk threshold (${threshold}). ${score.summary}`;
    }
  }

  // No PRD = higher risk (ralph might do unexpected things)
  if (!opts.hasPrd) {
    return 'Ralph without a PRD is not recommended — results will be unpredictable';
  }

  return null;
}

/**
 * Evaluate risk of an exec_claude operation.
 * Direct mode has higher base risk than worktree mode.
 */
export function evaluateClaudeRisk(opts: {
  useWorktree: boolean;
  promptLength: number;
  riskThreshold?: number;
}): string | null {
  const threshold = opts.riskThreshold ?? 15;

  if (!opts.useWorktree) {
    const score = scoreRisk({
      operation: 'exec_arbitrary',
      affectsMultipleFiles: false,
      isReversible: true,
    });
    if (score.total >= threshold) {
      return `Direct mode execution exceeds risk threshold (${threshold}). ${score.summary}`;
    }
    if (opts.promptLength > 5000) {
      return 'Direct mode with very long prompt (>5000 chars) — consider using worktree mode for safety';
    }
  }
  return null;
}
