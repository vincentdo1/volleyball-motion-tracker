/** Error and warning taxonomy shared by the engine and the UI (plan §3.13). */

export type EngineErrorCode =
  | 'unsupported-browser'
  | 'unsupported-container'
  | 'unsupported-codec'
  | 'no-video-track'
  | 'corrupt-file'
  | 'model-download'
  | 'model-integrity'
  | 'model-load'
  | 'gpu-unavailable'
  | 'gpu-lost'
  | 'out-of-memory'
  | 'inference-timeout'
  | 'inference-failed'
  | 'storage-quota'
  | 'storage-unavailable'
  | 'encode-unsupported'
  | 'export-failed'
  | 'worker-crashed'
  | 'invalid-state'
  | 'internal';

/** What the UI should offer. */
export type ErrorAction = 'retry' | 'fallback-tier' | 'reload' | 'change-browser' | 'choose-another-file' | 'none';

export interface EngineError {
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly action: ErrorAction;
  /** Machine-readable context (codec string, model id, HTTP status, ...). Never contains file contents. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export const ERROR_DEFAULTS: Readonly<
  Record<EngineErrorCode, { readonly recoverable: boolean; readonly action: ErrorAction; readonly title: string }>
> = {
  'unsupported-browser': {
    recoverable: false,
    action: 'change-browser',
    title: 'This browser cannot run the analysis',
  },
  'unsupported-container': {
    recoverable: false,
    action: 'choose-another-file',
    title: 'This file format is not supported',
  },
  'unsupported-codec': { recoverable: false, action: 'change-browser', title: 'This browser cannot decode this video' },
  'no-video-track': { recoverable: false, action: 'choose-another-file', title: 'The file has no video track' },
  'corrupt-file': { recoverable: false, action: 'choose-another-file', title: 'The file looks damaged' },
  'model-download': { recoverable: true, action: 'retry', title: 'Model download failed' },
  'model-integrity': { recoverable: true, action: 'retry', title: 'A downloaded model was corrupted' },
  'model-load': { recoverable: true, action: 'fallback-tier', title: 'A model could not be loaded on this device' },
  'gpu-unavailable': { recoverable: true, action: 'fallback-tier', title: 'The GPU is not available' },
  'gpu-lost': { recoverable: true, action: 'retry', title: 'The GPU was reset' },
  'out-of-memory': { recoverable: true, action: 'fallback-tier', title: 'The device ran out of memory' },
  'inference-timeout': { recoverable: true, action: 'fallback-tier', title: 'Processing stalled' },
  'inference-failed': { recoverable: true, action: 'fallback-tier', title: 'Processing failed on this device' },
  'storage-quota': { recoverable: true, action: 'none', title: 'Browser storage is full' },
  'storage-unavailable': { recoverable: true, action: 'none', title: 'Browser storage is unavailable' },
  'encode-unsupported': { recoverable: false, action: 'change-browser', title: 'This browser cannot encode video' },
  'export-failed': { recoverable: true, action: 'retry', title: 'Export failed' },
  'worker-crashed': { recoverable: true, action: 'reload', title: 'The processing engine stopped' },
  'invalid-state': { recoverable: true, action: 'none', title: 'That action is not available right now' },
  internal: { recoverable: false, action: 'reload', title: 'Something went wrong' },
};

export function engineError(
  code: EngineErrorCode,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): EngineError {
  const { recoverable, action } = ERROR_DEFAULTS[code];
  return detail === undefined ? { code, message, recoverable, action } : { code, message, recoverable, action, detail };
}

export type EngineWarningCode =
  | 'slow-mode'
  | 'decoder-fallback'
  | 'frames-skipped'
  | 'no-people-detected'
  | 'ball-model-gated'
  | 'storage-not-persistent'
  | 'resumed';

export interface EngineWarning {
  readonly code: EngineWarningCode;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export function isEngineError(value: unknown): value is EngineError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    value.code in ERROR_DEFAULTS &&
    'message' in value &&
    typeof value.message === 'string'
  );
}
