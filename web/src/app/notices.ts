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

/**
 * Plain-language text for warnings that deserve a toast. The engine's own message may carry runtime details
 * (shader or ONNX Runtime output), so it is never shown for these.
 */
export function noticeFor(warning: EngineWarning): Notice | null {
  if (isEngineWarning(warning)) {
    return {
      title: 'Switched to a slower mode',
      description:
        'Your graphics card had trouble, so the analysis runs on the processor. It takes longer, but the results are the same.',
    };
  }
  return null;
}
