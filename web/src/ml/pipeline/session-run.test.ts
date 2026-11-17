import type { InferenceSession } from 'onnxruntime-common';
import { describe, expect, it } from 'vitest';
import { isEngineError } from '@/contracts/errors';
import { InferenceError, runSession } from './session-run';

const failing = (message: string) =>
  ({ run: async () => Promise.reject(new Error(message)) }) as unknown as InferenceSession;

describe('runSession', () => {
  it('returns the outputs of a successful run', async () => {
    const outputs = { a: {} };
    const session = { run: async () => outputs } as unknown as InferenceSession;
    await expect(runSession(session, 'pose', {})).resolves.toBe(outputs);
  });

  it('turns a runtime rejection into a typed error with a plain message and the raw text as detail', async () => {
    const raw = "failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: Shader 'Pad' parsing error: expected ...";
    const error = await runSession(failing(raw), 'person-detector', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect(isEngineError(error)).toBe(true);
    const typed = error as InferenceError;
    expect(typed.code).toBe('inference-failed');
    expect(typed.action).toBe('fallback-tier');
    expect(typed.message).not.toMatch(/Ort|Pad|shader/i);
    expect(typed.detail).toEqual({ model: 'person-detector', runtime: raw });
  });

  it('leaves lost-device and out-of-memory failures for the engine to classify', async () => {
    for (const message of ['Device was lost', 'Failed to allocate: out of memory']) {
      await expect(runSession(failing(message), 'ball', {})).rejects.toThrow(message);
    }
  });
});
