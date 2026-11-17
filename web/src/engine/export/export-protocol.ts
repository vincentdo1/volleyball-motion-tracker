import type { EngineError } from '@/contracts/errors';
import type { ExportRequest, ProgressInfo } from '@/contracts/protocol';

/** Messages between the engine worker and the MP4 export worker it spawns. */
export type ExportWorkerCommand =
  | {
      readonly type: 'run';
      readonly file: File;
      /** The stored `posetrack.json` text. */
      readonly posetrack: string;
      readonly request: Extract<ExportRequest, { kind: 'mp4' }>;
    }
  | { readonly type: 'cancel' };

export type ExportWorkerEvent =
  | { readonly type: 'progress'; readonly progress: ProgressInfo }
  | {
      readonly type: 'done';
      readonly blob: Blob;
      readonly frames: number;
      readonly width: number;
      readonly height: number;
      readonly audioIncluded: boolean;
    }
  | { readonly type: 'error'; readonly error: EngineError };
