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

export interface PoseSample {
  readonly ptsUs: number;
  readonly player: RenderPlayer;
}

/**
 * Pose history of the tracks of a clip, for the focus-player layers (wrist trails, ghosts, velocity colour). Optional:
 * a frame without it simply draws none of those layers. Everything is keyed by PTS in microseconds.
 */
export interface PoseHistory {
  /**
   * Samples of `trackId` with PTS in [fromUs, toUs], oldest first (empty when the track has none there). Players are
   * in display px like `RenderFrame.players`; callers must not mutate them.
   */
  samples(trackId: number, fromUs: number, toUs: number): readonly PoseSample[];
  /**
   * Clip-wide 95th percentile of the track's wrist speed in body-heights per second (sets the velocity ramp's
   * scale). null when unknown, for instance while a clip is still being analysed.
   */
  wristSpeedP95(trackId: number): number | null;
}

export interface RenderFrame {
  readonly ptsUs: number;
  readonly frameIndex: number;
  readonly players: readonly RenderPlayer[];
  readonly ball: RenderBall | null;
  /** Source of the earlier (and later) samples the focus layers need; absent = no focus layers. */
  readonly history?: PoseHistory;
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
  /**
   * Focus-player layers (05 §2.9, §2.10). They need `focusTrackId` and `RenderFrame.history`; each is optional so an
   * older caller (the MP4 export's request) keeps working, and an absent value takes the default noted here.
   */
  /** Wrist comet trails and the centre-of-mass trail of the focus player. Default true. */
  readonly showFocusTrails?: boolean;
  /** Onion-skin ghosts of the focus player. Default false. */
  readonly showGhosts?: boolean;
  /** Angle arcs (hitting elbow and both knees) of the focus player. Default false. */
  readonly showAngles?: boolean;
  /** Colour the focus player's bones by joint speed instead of identity. Default false. */
  readonly velocityColor?: boolean;
  /** Shorter trails (0.2 s) and static ghosts. Default false. */
  readonly reducedMotion?: boolean;
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
  showFocusTrails: true,
  showGhosts: false,
  showAngles: false,
  velocityColor: false,
  reducedMotion: false,
};

export type SkeletonLevel = 'full' | 'partial' | 'torso' | 'marker' | 'hidden';

export interface RenderStats {
  readonly drawMs: number;
  readonly players: number;
  readonly levels: Readonly<Record<SkeletonLevel, number>>;
  /**
   * What the focus layers did this frame. `ghosts`: 'drawn', 'still' (the focus player barely moved, so ghosts would
   * stack on the body and none are drawn) or 'off'. Absent when the renderer has no focus layers.
   */
  readonly focus?: { readonly ghosts: 'off' | 'drawn' | 'still' };
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
