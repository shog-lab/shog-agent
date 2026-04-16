/**
 * Spawn utilities — run a process and capture output.
 * Replaces duplicated spawn + buffer capture patterns in claude-code.ts.
 */

import { spawn, type SpawnOptionsWithoutStdio } from 'child_process';
import { ErrorCode, makeError, type ExecResult } from './errors.js';

/**
 * Spawn a process, capture stdout + stderr, return ExecResult.
 * Resolves (never rejects) — errors are returned as ExecResult with status 'error'.
 */
export function spawnAndCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptionsWithoutStdio & { maxOutputChars?: number },
): Promise<ExecResult> {
  const maxOutput = opts.maxOutputChars ?? 10000;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn(cmd, args, {
      ...opts,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d));

    proc.on('close', (code) => {
      resolve({
        status: code === 0 ? 'success' : 'failed',
        output: Buffer.concat(chunks).toString('utf-8').slice(-maxOutput),
      });
    });

    proc.on('error', (err) => {
      resolve(makeError(ErrorCode.EXECUTION, String(err)));
    });
  });
}
