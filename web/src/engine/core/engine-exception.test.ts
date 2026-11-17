import { describe, expect, it } from 'vitest';
import { type EngineError, engineError } from '@/contracts/errors';
import { fail, plainEngineError, toEngineError } from './engine-exception';

/** The shape of the ML module's `InferenceError`: an `Error` that carries the `EngineError` fields. */
class ErrorWithFields extends Error implements EngineError {
  readonly code = 'inference-failed';
  readonly recoverable = true;
  readonly action = 'fallback-tier';
  readonly detail = { model: 'detector', runtime: 'Shader "Pad" parsing error' };
  constructor() {
    super('This device could not run the analysis model.');
    this.name = 'InferenceError';
  }
}

describe('toEngineError', () => {
  it('returns a plain object for an Error subclass that implements EngineError', () => {
    const mapped = toEngineError(new ErrorWithFields());
    expect(mapped).not.toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(mapped)).toBe(Object.prototype);
    expect(Object.keys(mapped).sort()).toEqual(['action', 'code', 'detail', 'message', 'recoverable']);
  });

  it('survives structured clone with code, action, recoverable and detail', () => {
    const cloned = structuredClone(toEngineError(new ErrorWithFields()));
    expect(cloned).toEqual({
      code: 'inference-failed',
      message: 'This device could not run the analysis model.',
      recoverable: true,
      action: 'fallback-tier',
      detail: { model: 'detector', runtime: 'Shader "Pad" parsing error' },
    });
  });

  it('keeps the plain object of an EngineException and of an already plain error', () => {
    const plain = engineError('gpu-lost', 'lost');
    expect(toEngineError(plain)).toEqual(plain);
    expect(toEngineError(fail('storage-quota', 'full'))).toEqual(engineError('storage-quota', 'full'));
  });

  it('plainEngineError does not alias the detail record', () => {
    const source = engineError('model-load', 'x', { model: 'pose' });
    const copy = plainEngineError(source);
    expect(copy.detail).toEqual(source.detail);
    expect(copy.detail).not.toBe(source.detail);
  });
});
