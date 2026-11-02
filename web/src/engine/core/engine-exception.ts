import { type EngineError, type EngineErrorCode, engineError, isEngineError } from '@/contracts/errors';

/** An `EngineError` that can be thrown and rejected with; it satisfies `isEngineError` itself. */
export class EngineException extends Error implements EngineError {
  readonly code: EngineErrorCode;
  readonly recoverable: boolean;
  readonly action: EngineError['action'];
  readonly detail?: EngineError['detail'];

  constructor(error: EngineError) {
    super(error.message);
    this.name = 'EngineException';
    this.code = error.code;
    this.recoverable = error.recoverable;
    this.action = error.action;
    if (error.detail !== undefined) this.detail = error.detail;
  }

  get engineError(): EngineError {
    return engineError(this.code, this.message, this.detail);
  }
}

export function fail(
  code: EngineErrorCode,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): EngineException {
  return new EngineException(engineError(code, message, detail));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

/** Maps anything thrown inside the engine to a taxonomy code (plan §3.13). */
export function toEngineError(error: unknown, fallback: EngineErrorCode = 'internal'): EngineError {
  if (error instanceof EngineException) return error.engineError;
  if (isEngineError(error)) return error;
  const message = messageOf(error);
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') return engineError('storage-quota', message);
    if (error.name === 'NotSupportedError') return engineError('unsupported-codec', message);
    if (error.name === 'SecurityError' || error.name === 'InvalidStateError')
      return engineError(fallback, message, { domException: error.name });
  }
  if (/device (was )?lost|GPUDevice.*lost|context lost/i.test(message)) return engineError('gpu-lost', message);
  if (/out of memory|allocation failed|OOM|Array buffer allocation|memory access out of bounds/i.test(message)) {
    return engineError('out-of-memory', message);
  }
  return engineError(fallback, message);
}
