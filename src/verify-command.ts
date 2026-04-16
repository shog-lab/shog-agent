/**
 * VerifyCommand — safe command whitelist for Claude Code execution.
 *
 * Defines what commands Claude Code is allowed to run in different modes.
 * Inspired by prax-agent's verify_command.py.
 */

/** Read-only tools — always safe */
const READ_TOOLS = ['Read', 'Glob', 'Grep'];

/** Safe shell commands — read-only or side-effect-free */
const SAFE_BASH = [
  'Bash(cat *)',
  'Bash(ls *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(find *)',
  'Bash(echo *)',
  'Bash(wc *)',
  'Bash(diff *)',
  'Bash(grep *)',
  'Bash(sort *)',
  'Bash(pwd)',
];

/** Verification commands — test/lint/typecheck only */
const VERIFY_BASH = [
  'Bash(pnpm test *)',
  'Bash(pnpm run test *)',
  'Bash(pnpm run lint *)',
  'Bash(pnpm run build *)',
  'Bash(pnpm -w run test *)',
  'Bash(pnpm -w run lint *)',
  'Bash(pnpm -w run build *)',
  'Bash(pnpm -r test *)',
  'Bash(npm test *)',
  'Bash(npm run test *)',
  'Bash(npm run lint *)',
  'Bash(npm run build *)',
  'Bash(npx vitest *)',
  'Bash(npx tsc *)',
  'Bash(npx eslint *)',
  'Bash(node *)',
  'Bash(pytest *)',
  'Bash(python -m pytest *)',
  'Bash(cargo test *)',
  'Bash(go test *)',
];

/** Browser automation tools */
const BROWSER_BASH = [
  'Bash(agent-browser *)',
  'Bash(lsof *)',
  'Bash(xargs kill *)',
  'Bash(curl *)',
];

/** File operation tools (for artifacts dir only) */
const FILE_BASH = ['Bash(mkdir *)', 'Bash(cp *)'];

/** Git read-only commands */
const GIT_READ_BASH = [
  'Bash(git log *)',
  'Bash(git diff *)',
  'Bash(git show *)',
  'Bash(git status *)',
  'Bash(git branch *)',
  'Bash(git rev-parse *)',
];

/**
 * Get allowed tools for exec_claude direct mode (black box testing).
 * No file writes, no destructive commands.
 */
export function getDirectModeTools(): string[] {
  return [
    ...READ_TOOLS,
    ...SAFE_BASH,
    ...VERIFY_BASH,
    ...BROWSER_BASH,
    ...FILE_BASH,
    ...GIT_READ_BASH,
  ];
}

/**
 * Get disallowed tools for exec_claude worktree mode (code review).
 * Can read and run commands, but cannot write files.
 */
export function getWorktreeModeDisallowedTools(): string[] {
  return ['Write', 'Edit', 'NotebookEdit'];
}
