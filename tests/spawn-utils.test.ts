import { describe, expect, it } from 'vitest';

import { spawnAndCapture } from '../src/spawn-utils.js';

describe('spawnAndCapture', () => {
  it('captures stdout from successful command', async () => {
    const result = await spawnAndCapture('echo', ['hello world'], { cwd: '.' });
    expect(result.status).toBe('success');
    expect(result.output.trim()).toBe('hello world');
  });

  it('returns failed status for non-zero exit', async () => {
    const result = await spawnAndCapture('node', ['-e', 'process.exit(1)'], {
      cwd: '.',
    });
    expect(result.status).toBe('failed');
  });

  it('returns error for non-existent command', async () => {
    const result = await spawnAndCapture('nonexistent-cmd-12345', [], {
      cwd: '.',
    });
    expect(result.status).toBe('error');
  });

  it('captures stderr', async () => {
    const result = await spawnAndCapture(
      'node',
      ['-e', 'console.error("err msg"); process.exit(1)'],
      { cwd: '.' },
    );
    expect(result.output).toContain('err msg');
  });

  it('truncates output to maxOutputChars', async () => {
    const result = await spawnAndCapture(
      'node',
      ['-e', 'console.log("x".repeat(50000))'],
      {
        cwd: '.',
        maxOutputChars: 100,
      },
    );
    expect(result.output.length).toBeLessThanOrEqual(101); // +1 for newline
  });
});
