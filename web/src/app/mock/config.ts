import { type EngineErrorCode, ERROR_DEFAULTS } from '@/contracts/errors';

/** What `?mock=...` asks the mock engine to do. Comma-separated: `?mock=fast,error:corrupt-file`. */
export interface MockConfig {
  /** Fail with this error at the stage where the real engine would raise it. */
  readonly errorCode: EngineErrorCode | null;
  /** The clip contains no people (empty state). */
  readonly empty: boolean;
  /** Many people in the clip (a crowd: dozens of tracks), to exercise long player lists. */
  readonly crowd: boolean;
  /** Delay between processing chunks, ms. `fast` is for tests. */
  readonly chunkDelayMs: number;
}

export const DEFAULT_MOCK_CONFIG: MockConfig = { errorCode: null, empty: false, crowd: false, chunkDelayMs: 90 };
const FAST_CHUNK_DELAY_MS = 2;

function isErrorCode(value: string): value is EngineErrorCode {
  return value in ERROR_DEFAULTS;
}

/** Parses the `mock` query parameter; null when the app should use the real engine. */
export function parseMockParam(search: string): MockConfig | null {
  const raw = new URLSearchParams(search).get('mock');
  if (raw === null) return null;
  let config: MockConfig = DEFAULT_MOCK_CONFIG;
  for (const part of raw.split(',')) {
    if (part === 'fast') config = { ...config, chunkDelayMs: FAST_CHUNK_DELAY_MS };
    else if (part === 'empty') config = { ...config, empty: true };
    else if (part === 'crowd') config = { ...config, crowd: true };
    else if (part.startsWith('error:')) {
      const code = part.slice('error:'.length);
      if (isErrorCode(code)) config = { ...config, errorCode: code };
    }
  }
  return config;
}

export type FailureStage = 'init' | 'open' | 'processing' | 'export';

/** Where each error is raised: start-up, opening the file, mid-run or while exporting. */
export function failureStage(code: EngineErrorCode): FailureStage {
  switch (code) {
    case 'unsupported-browser':
    case 'model-download':
    case 'model-integrity':
    case 'model-load':
    case 'gpu-unavailable':
    case 'storage-quota':
    case 'storage-unavailable':
      return 'init';
    case 'unsupported-container':
    case 'unsupported-codec':
    case 'no-video-track':
    case 'corrupt-file':
      return 'open';
    case 'encode-unsupported':
    case 'export-failed':
      return 'export';
    default:
      return 'processing';
  }
}
