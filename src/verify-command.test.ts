import { describe, expect, it } from 'vitest';

import {
  getDirectModeTools,
  getWorktreeModeDisallowedTools,
} from './verify-command.js';

describe('getDirectModeTools', () => {
  const tools = getDirectModeTools();

  it('includes read-only tools', () => {
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
  });

  it('includes safe bash commands', () => {
    expect(tools).toContain('Bash(cat *)');
    expect(tools).toContain('Bash(ls *)');
  });

  it('includes verify commands', () => {
    expect(tools).toContain('Bash(pnpm test *)');
    expect(tools).toContain('Bash(npm test *)');
    expect(tools).toContain('Bash(pytest *)');
    expect(tools).toContain('Bash(cargo test *)');
    expect(tools).toContain('Bash(go test *)');
  });

  it('includes browser tools', () => {
    expect(tools).toContain('Bash(agent-browser *)');
  });

  it('includes git read-only commands', () => {
    expect(tools).toContain('Bash(git log *)');
    expect(tools).toContain('Bash(git diff *)');
    expect(tools).toContain('Bash(git status *)');
  });

  it('does NOT include destructive tools', () => {
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Bash(rm *)');
    expect(tools).not.toContain('Bash(git push *)');
    expect(tools).not.toContain('Bash(git checkout *)');
    expect(tools).not.toContain('Bash(git reset *)');
  });
});

describe('getWorktreeModeDisallowedTools', () => {
  const tools = getWorktreeModeDisallowedTools();

  it('disallows file write tools', () => {
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('NotebookEdit');
  });

  it('does not disallow read tools', () => {
    expect(tools).not.toContain('Read');
    expect(tools).not.toContain('Bash');
  });
});
