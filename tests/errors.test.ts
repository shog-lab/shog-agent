import { describe, expect, it } from 'vitest';

import { ErrorCode, makeError, isError } from '../src/errors.js';

describe('makeError', () => {
  it('creates error with code and message', () => {
    const err = makeError(ErrorCode.VALIDATION, 'missing field');
    expect(err.status).toBe('error');
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('missing field');
    expect(err.output).toBeUndefined();
  });

  it('creates error with output', () => {
    const err = makeError(
      ErrorCode.EXECUTION,
      'process crashed',
      'stack trace...',
    );
    expect(err.output).toBe('stack trace...');
  });
});

describe('isError', () => {
  it('returns true for ErrorResult', () => {
    const err = makeError(ErrorCode.PERMISSION, 'blocked');
    expect(isError(err)).toBe(true);
  });

  it('returns false for SuccessResult', () => {
    expect(isError({ status: 'success', output: 'ok' })).toBe(false);
  });

  it('returns false for failed result', () => {
    expect(isError({ status: 'failed', output: 'test failed' })).toBe(false);
  });
});

describe('ErrorCode', () => {
  it('has all expected codes', () => {
    expect(ErrorCode.VALIDATION).toBe('VALIDATION');
    expect(ErrorCode.PERMISSION).toBe('PERMISSION');
    expect(ErrorCode.EXECUTION).toBe('EXECUTION');
    expect(ErrorCode.MODEL).toBe('MODEL');
    expect(ErrorCode.RESOURCE).toBe('RESOURCE');
    expect(ErrorCode.INTERNAL).toBe('INTERNAL');
  });
});
