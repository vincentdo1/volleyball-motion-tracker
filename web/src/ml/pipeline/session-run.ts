import type { InferenceSession } from 'onnxruntime-common';
import { type EngineError, engineError } from '@/contracts/errors';
import type { ModelRole } from '@/contracts/models';

/** Failures the engine recognises by their text (lost device, out of memory) and maps to their own codes. */
const CLASSIFIED_BY_ENGINE =
  /device (was )?lost|GPUDevice.*lost|context lost|out of memory|allocation failed|OOM|Array buffer allocation|memory access out of bounds/i;

const MAX_RAW_CHARS = 300;

/**
 * A model run that the runtime rejected (a shader the browser's WebGPU cannot compile, an unsupported operator). It
 * carries the engine's `inference-failed` taxonomy entry, whose action is the tier step-down, and a plain-language
 * message; the runtime's own text, which is meant for developers, is kept in `cause` and `detail.runtime`.
 */
export class InferenceError extends Error implements EngineError {
  readonly code = 'inference-failed';
  readonly recoverable: boolean;
  readonly action: EngineError['action'];
  readonly detail: NonNullable<EngineError['detail']>;

  constructor(role: ModelRole, cause: unknown) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const taxonomy = engineError('inference-failed', 'This device could not run the analysis model.');
    super(taxonomy.message, { cause });
    this.name = 'InferenceError';
    this.recoverable = taxonomy.recoverable;
    this.action = taxonomy.action;
    this.detail = { model: role, runtime: raw.slice(0, MAX_RAW_CHARS) };
  }
}

/** `session.run` with runtime failures turned into `InferenceError` (lost device and out-of-memory pass through). */
export async function runSession(
  session: InferenceSession,
  role: ModelRole,
  feeds: InferenceSession.OnnxValueMapType,
): Promise<InferenceSession.OnnxValueMapType> {
  try {
    return await session.run(feeds);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (CLASSIFIED_BY_ENGINE.test(text)) throw error;
    throw new InferenceError(role, error);
  }
}
