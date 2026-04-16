/**
 * Unified error types for ShogAgent.
 *
 * All errors across the system (IPC, exec_ralph, exec_claude, agent runner)
 * use these types for consistent classification and handling.
 */

/** Error categories */
export enum ErrorCode {
  // Validation errors — bad input, missing params
  VALIDATION = 'VALIDATION',
  // Permission/security — blocked by risk scorer, whitelist, dirty check
  PERMISSION = 'PERMISSION',
  // Execution — process failed, timeout, crash
  EXECUTION = 'EXECUTION',
  // Model/API — LLM API errors, rate limits, auth failures
  MODEL = 'MODEL',
  // Resource — timeout, iteration limit, disk full
  RESOURCE = 'RESOURCE',
  // Internal — unexpected errors, bugs
  INTERNAL = 'INTERNAL',
}

/** Standard error result returned from exec_ralph / exec_claude / IPC */
export interface ErrorResult {
  status: 'error';
  code: ErrorCode;
  message: string;
  /** Optional: raw output from failed process */
  output?: string;
}

/** Standard success result */
export interface SuccessResult {
  status: 'success' | 'failed';
  output: string;
}

export type ExecResult = SuccessResult | ErrorResult;

/** Helper to create an error result */
export function makeError(
  code: ErrorCode,
  message: string,
  output?: string,
): ErrorResult {
  return { status: 'error', code, message, output };
}

/** Helper to check if a result is an error */
export function isError(result: ExecResult): result is ErrorResult {
  return result.status === 'error' && 'code' in result;
}
