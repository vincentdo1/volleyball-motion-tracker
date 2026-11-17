import type { ProcessingSettings } from '@/contracts/params';
import type { FrameTableColumns } from '@/contracts/posetrack';

/** Slack so 59.94 fps against a 60 fps cap still processes every frame. */
const RATE_SLACK = 0.05;

/** Every n-th frame keeps the processed rate at or below `maxProcessFps` (plan §3.6; timestamps stay exact). */
export function strideFor(nominalFps: number, maxProcessFps: number): number {
  if (nominalFps <= 0 || maxProcessFps <= 0) return 1;
  return Math.max(1, Math.ceil(nominalFps / maxProcessFps - RATE_SLACK));
}

/** Which frames a run decodes, runs the detector on and feeds to the ball model. All keyed by absolute frame index. */
export interface FramePlan {
  readonly stride: number;
  /** First frame index inside the processed range. */
  readonly firstIndex: number;
  /** One past the last frame index inside the processed range. */
  readonly endIndex: number;
  isProcessed(index: number): boolean;
  runDetector(index: number): boolean;
  runBall(index: number): boolean;
  /** Number of frames the run will process. */
  readonly processedCount: number;
}

export function makePlan(
  table: FrameTableColumns,
  nominalFps: number,
  settings: ProcessingSettings,
  rangeUs?: readonly [number, number],
): FramePlan {
  const n = table.ptsUs.length;
  let firstIndex = 0;
  let endIndex = n;
  if (rangeUs) {
    firstIndex = table.ptsUs.findIndex((pts) => pts >= rangeUs[0]);
    if (firstIndex < 0) firstIndex = n;
    const end = table.ptsUs.findIndex((pts) => pts >= rangeUs[1]);
    endIndex = end < 0 ? n : end;
  }
  const stride = strideFor(nominalFps, settings.maxProcessFps);
  const cadence = Math.max(1, settings.detector.cadence);
  const ballStride = Math.max(1, Math.ceil(nominalFps / stride / settings.ball.inputFps.max - RATE_SLACK));
  const hasBall = settings.models.ball !== null;
  const ordinal = (index: number) => Math.floor((index - firstIndex) / stride);
  const isProcessed = (index: number) => index >= firstIndex && index < endIndex && (index - firstIndex) % stride === 0;
  return {
    stride,
    firstIndex,
    endIndex,
    isProcessed,
    runDetector: (index) => ordinal(index) % cadence === 0,
    runBall: (index) => hasBall && ordinal(index) % ballStride === 0,
    processedCount: Math.max(0, Math.ceil((endIndex - firstIndex) / stride)),
  };
}
