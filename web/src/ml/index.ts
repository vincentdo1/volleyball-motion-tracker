/** The ML module the engine calls: per-frame pipeline, online tracker and offline finalize. */
import type { MlModule } from '@/contracts/pipeline';
import { createFramePipeline } from './pipeline/frame-pipeline';
import { finalize } from './postprocess/finalize';
import { sessionOptions } from './session-options';
import { defaultSettings } from './settings';
import { createOnlineTracker } from './tracking/online-tracker';

export const mlModule: MlModule = {
  defaultSettings,
  sessionOptions,
  createFramePipeline,
  createOnlineTracker,
  finalize,
};

export { sessionOptions } from './session-options';
