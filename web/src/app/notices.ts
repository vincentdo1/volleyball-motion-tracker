import { DEVICE_TIERS, type DeviceTierId } from '@/contracts/capabilities';
import type { EngineWarning } from '@/contracts/errors';

export interface Notice {
  readonly title: string;
  readonly description: string;
}

/**
 * Warning code for "an inference failed at runtime, so the engine stepped down to the processor (WASM) tier".
 * It is not in `EngineWarningCode` yet (CONTRACT-REQUEST in the UI progress file), so it is matched as a plain string.
 */
const TIER_FALLBACK = 'tier-fallback';

/** Notes about the engine itself (it runs in slow mode), not about one clip: they can arrive before a clip is open. */
export function isEngineWarning(warning: EngineWarning): boolean {
  const code: string = warning.code;
  return code === TIER_FALLBACK || code === 'slow-mode';
}

/** The engine stepped down after a stall, or to a lighter mode that still runs on the graphics card. */
function isLighterStep(warning: EngineWarning): boolean {
  const tier = warning.detail?.tier;
  const onGpu =
    typeof tier === 'string' && tier in DEVICE_TIERS && DEVICE_TIERS[tier as DeviceTierId].backend === 'webgpu';
  return onGpu || warning.detail?.reason === 'stalled';
}

/**
 * Plain-language text for warnings that deserve a toast. The engine's own message may carry runtime details
 * (shader or ONNX Runtime output), so it is never shown for these. `analysing`: a clip is being analysed, and a
 * change of mode starts it again from the beginning. A lower mode uses smaller models, so the text never promises
 * identical results.
 */
export function noticeFor(warning: EngineWarning, analysing = false): Notice | null {
  if (!isEngineWarning(warning)) return null;
  if (isLighterStep(warning)) {
    return {
      title: 'Switched to a lighter mode',
      description: analysing
        ? 'The analysis stopped responding, so it started again from the beginning in a lighter mode. It may be a little less precise.'
        : 'The analysis stopped responding, so Skeletal now uses a lighter mode. It may be a little less precise.',
    };
  }
  return {
    title: 'Switched to a slower mode',
    description: analysing
      ? 'Your graphics card had trouble, so the analysis started again from the beginning on the processor. It takes longer and may be a little less precise.'
      : "Your graphics card can't run the analysis models, so Skeletal uses the processor. It takes longer and may be a little less precise.",
  };
}

/** The toast for a run that started again from the beginning with no change of mode to explain it. */
export const RESTART_NOTICE: Notice = {
  title: 'Analysis restarted',
  description: 'The analysis was interrupted, so it started again from the beginning.',
};
