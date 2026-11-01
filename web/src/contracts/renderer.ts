/**
 * Renderer input interface (05 §2.1, §2.13). The implementation (`web/src/render/`) must be worker-safe: it draws on
 * either a CanvasRenderingContext2D or an OffscreenCanvasRenderingContext2D, with no DOM globals and no React,
 * because the MP4 export worker uses the same renderer.
 */
import type { BallVisibilityCode } from './posetrack';

export type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Identity palette v3 (8 CVD-tuned hues, 05 §2.4). Slots >= 8 reuse `slot % 8` with a secondary cue. */
export const IDENTITY_PALETTE = [
  '#25d2fc',
  '#edee45',
  '#f48a64',
  '#9efbda',
  '#efa3c7',
  '#fcc687',
  '#b0cd26',
  '#6fbe95',
] as const;
/** Dark casing under every hue (contrast on sunlit sand). */
export const CASING_COLOR = '#04060a';

export interface RenderPlayer {
  readonly trackId: number;
  readonly label: string;
  readonly colorSlot: number;
  /** Display px [x0, y0, x1, y1]; null when the track has no box this frame. */
  readonly box: readonly [number, number, number, number] | null;
  readonly boxScore: number;
  /** 78 values (x, y, score in display px), NaN missing; null = box only (draw a marker). */
  readonly keypoints: Float32Array | null;
  /** 26 `KeypointFlag` values. */
  readonly kpFlags: Uint8Array | null;
  /** `SampleFlag` bits. */
  readonly sampleFlags: number;
  /** Per-bone median length of this track in display px (plausibility gate), indexed like RENDER_BONES. */
  readonly refBoneLengths: Float32Array | null;
}

export interface RenderBall {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly confidence: number;
  readonly visibility: BallVisibilityCode;
  /** Recent positions, x/y pairs in display px, oldest first. */
  readonly trail: Float32Array | null;
}

export interface RenderFrame {
  readonly ptsUs: number;
  readonly frameIndex: number;
  readonly players: readonly RenderPlayer[];
  readonly ball: RenderBall | null;
}

/** Display px -> canvas px: `cx = (x * scale + offsetX) * dpr`, `cy = (y * scale + offsetY) * dpr`. */
export interface ViewTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly dpr: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface RenderOptions {
  readonly colorMode: 'identity' | 'side';
  readonly focusTrackId: number | null;
  readonly hiddenTrackIds: readonly number[];
  readonly showJoints: boolean;
  readonly showChips: boolean;
  readonly showBall: boolean;
  readonly showTrails: boolean;
  /** 0..1, scaled down automatically on bright backgrounds. */
  readonly glow: number;
  readonly contextAlpha: number;
  /** Mean background luma 0..1 under the players, if known. */
  readonly bgLuma: number | null;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  colorMode: 'identity',
  focusTrackId: null,
  hiddenTrackIds: [],
  showJoints: true,
  showChips: true,
  showBall: true,
  showTrails: true,
  glow: 1,
  contextAlpha: 0.6,
  bgLuma: null,
};

export type SkeletonLevel = 'full' | 'partial' | 'torso' | 'marker' | 'hidden';

export interface RenderStats {
  readonly drawMs: number;
  readonly players: number;
  readonly levels: Readonly<Record<SkeletonLevel, number>>;
}

export interface SkeletonRenderer {
  draw(ctx: Canvas2DContext, frame: RenderFrame, view: ViewTransform, options: RenderOptions): RenderStats;
  dispose(): void;
}

export type SkeletonRendererFactory = () => SkeletonRenderer;

/** View transform for a video drawn with `object-fit: contain` into a box of boxWidth x boxHeight CSS px. */
export function containTransform(
  displayWidth: number,
  displayHeight: number,
  boxWidth: number,
  boxHeight: number,
  dpr: number,
): ViewTransform {
  const scale = Math.min(boxWidth / displayWidth, boxHeight / displayHeight);
  return {
    scale,
    offsetX: (boxWidth - displayWidth * scale) / 2,
    offsetY: (boxHeight - displayHeight * scale) / 2,
    dpr,
    canvasWidth: Math.round(boxWidth * dpr),
    canvasHeight: Math.round(boxHeight * dpr),
  };
}
