import { describe, expect, it } from 'vitest';

import {
  scoreRisk,
  evaluateRalphRisk,
  evaluateClaudeRisk,
} from '../src/risk-scorer.js';

describe('scoreRisk', () => {
  it('scores read operations as LOW', () => {
    const score = scoreRisk({ operation: 'read', filePath: 'src/index.ts' });
    expect(score.level).toBe('LOW');
    expect(score.total).toBeGreaterThanOrEqual(4);
    expect(score.total).toBeLessThanOrEqual(8);
  });

  it('scores test operations as LOW-MEDIUM', () => {
    const score = scoreRisk({
      operation: 'test',
      filePath: 'test/foo.test.ts',
    });
    expect(score.level).toBe('LOW');
  });

  it('scores editing .env as HIGH risk', () => {
    const score = scoreRisk({
      operation: 'edit',
      filePath: '.env',
      affectsMultipleFiles: true,
      isReversible: false,
    });
    expect(score.level).toBe('HIGH');
    expect(score.fileSensitivity).toBe(5);
  });

  it('scores deleting package.json as HIGH', () => {
    const score = scoreRisk({
      operation: 'delete',
      filePath: 'package.json',
      affectsMultipleFiles: false,
      isReversible: false,
    });
    expect(score.level).toBe('HIGH');
  });

  it('scores editing test files as LOW', () => {
    const score = scoreRisk({
      operation: 'edit',
      filePath: 'tests/unit.test.ts',
      isReversible: true,
    });
    expect(score.level).toBe('LOW');
  });

  it('multi-file operations increase scope score', () => {
    const single = scoreRisk({ operation: 'edit', filePath: 'src/a.ts' });
    const multi = scoreRisk({
      operation: 'edit',
      filePath: 'src/a.ts',
      affectsMultipleFiles: true,
    });
    expect(multi.total).toBeGreaterThan(single.total);
  });

  it('irreversible operations increase reversibility score', () => {
    const reversible = scoreRisk({
      operation: 'edit',
      filePath: 'src/a.ts',
      isReversible: true,
    });
    const irreversible = scoreRisk({
      operation: 'edit',
      filePath: 'src/a.ts',
      isReversible: false,
    });
    expect(irreversible.total).toBeGreaterThan(reversible.total);
  });

  it('summary includes all axes', () => {
    const score = scoreRisk({ operation: 'read' });
    expect(score.summary).toContain('Risk');
    expect(score.summary).toContain('tool=');
    expect(score.summary).toContain('file=');
    expect(score.summary).toContain('scope=');
    expect(score.summary).toContain('reversibility=');
  });

  it('handles unknown operation gracefully', () => {
    const score = scoreRisk({ operation: 'unknown_op' });
    expect(score.toolRisk).toBe(3); // default
    expect(score.total).toBeGreaterThanOrEqual(4);
  });

  it('handles unknown file path gracefully', () => {
    const score = scoreRisk({
      operation: 'read',
      filePath: 'some/random/path',
    });
    expect(score.fileSensitivity).toBe(2); // default
  });

  it('sensitive file patterns match correctly', () => {
    expect(
      scoreRisk({ operation: 'read', filePath: '.env.local' }).fileSensitivity,
    ).toBe(5);
    expect(
      scoreRisk({ operation: 'read', filePath: 'credentials.json' })
        .fileSensitivity,
    ).toBe(5);
    expect(
      scoreRisk({ operation: 'read', filePath: 'id_rsa' }).fileSensitivity,
    ).toBe(5);
    expect(
      scoreRisk({ operation: 'read', filePath: 'package.json' })
        .fileSensitivity,
    ).toBe(4);
    expect(
      scoreRisk({ operation: 'read', filePath: '.github/workflows/ci.yml' })
        .fileSensitivity,
    ).toBe(4);
    expect(
      scoreRisk({ operation: 'read', filePath: 'Dockerfile' }).fileSensitivity,
    ).toBe(3);
    expect(
      scoreRisk({ operation: 'read', filePath: 'src/index.ts' })
        .fileSensitivity,
    ).toBe(2);
    expect(
      scoreRisk({ operation: 'read', filePath: 'docs/README.md' })
        .fileSensitivity,
    ).toBe(1);
  });
});

describe('evaluateRalphRisk', () => {
  it('returns null for normal usage', () => {
    expect(
      evaluateRalphRisk({ feature: 'test', iterations: 10, hasPrd: true }),
    ).toBeNull();
  });

  it('warns on no PRD', () => {
    const result = evaluateRalphRisk({
      feature: 'test',
      iterations: 10,
      hasPrd: false,
    });
    expect(result).toContain('PRD');
  });

  it('handles high iterations', () => {
    const result = evaluateRalphRisk({
      feature: 'test',
      iterations: 18,
      hasPrd: true,
    });
    // May or may not warn depending on score, but should not throw
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

describe('evaluateClaudeRisk', () => {
  it('returns null for worktree mode', () => {
    expect(
      evaluateClaudeRisk({ useWorktree: true, promptLength: 100 }),
    ).toBeNull();
  });

  it('returns null for short direct mode prompts', () => {
    expect(
      evaluateClaudeRisk({ useWorktree: false, promptLength: 100 }),
    ).toBeNull();
  });

  it('warns on very long direct mode prompts', () => {
    const result = evaluateClaudeRisk({
      useWorktree: false,
      promptLength: 6000,
    });
    expect(result).toContain('Direct');
  });
});
