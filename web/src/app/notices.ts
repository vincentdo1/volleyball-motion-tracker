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

/**
 * Plain-language text for warnings that deserve a toast. The engine's own message may carry runtime details
 * (shader or ONNX Runtime output), so it is never shown for these.
 */
export function noticeFor(warning: EngineWarning): Notice | null {
  const code: string = warning.code;
  if (code === TIER_FALLBACK || code === 'slow-mode') {
    return {
      title: 'Switched to a slower mode',
      description:
        'Your graphics card had trouble with this clip, so the analysis continues on the processor. It takes longer, but the results are the same.',
    };
  }
  return null;
}
