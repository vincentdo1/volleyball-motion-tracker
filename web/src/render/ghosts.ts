import { CASING_COLOR, type Canvas2DContext, type PoseSample, type ViewTransform } from '@/contracts/renderer';
import { BONE_STYLES } from './bones';
import { hexToRgb, mix, type Rgb, rgba } from './color';
import type { FocusWindow } from './focus';
import { roundConePath } from './geometry';
import { JOINT, jointPosition } from './kinematics';
import { preparePlayer } from './prepare';
import { drawnBones } from './skeleton';

const CASING = hexToRgb(CASING_COLOR);
/** Older ghosts lean toward this blue (05 §2.9). */
const GHOST_TINT: Rgb = hexToRgb('#7896ff');

export const GHOST_COUNT = 6;
/** Time between ghosts, so six cover about 0.7 s of a spike. */
export const GHOST_STEP_S = 0.12;
/** The ghosts only show in place when the hips travel more than this many body heights across them (05 §2.9). */
export const GHOST_MIN_DISPLACEMENT = 0.5;
export const GHOST_WIDTH = 0.55;
/** How far back the sample window must reach to cover every ghost. */
export const GHOST_REACH_S = GHOST_COUNT * GHOST_STEP_S + GHOST_STEP_S / 2;

const US = 1e6;

export interface Ghost {
  readonly sample: PoseSample;
  /** 0 (oldest) to 1 (just before now). */
  readonly recency: number;
}

export interface GhostSet {
  readonly status: 'drawn' | 'still' | 'off';
  readonly ghosts: readonly Ghost[];
}

/**
 * Target times of the ghosts, oldest first. Normally `now - k * step`, so they trail the player. Under reduced motion
 * they are fixed snapshots on a time grid instead: the set grows through each block of six steps and starts over, so
 * nothing slides along with the playhead.
 */
export function ghostTimes(nowUs: number, reduced: boolean): number[] {
  const step = GHOST_STEP_S * US;
  const times: number[] = [];
  if (reduced) {
    const block = GHOST_COUNT * step;
    const start = Math.floor(nowUs / block) * block;
    for (let j = 0; j < GHOST_COUNT; j++) {
      const t = start + j * step;
      if (t <= nowUs - step / 2) times.push(t);
    }
    return times;
  }
  for (let k = GHOST_COUNT; k >= 1; k--) times.push(nowUs - k * step);
  return times;
}

function nearest(samples: readonly PoseSample[], target: number, tolerance: number, before: number): PoseSample | null {
  let best: PoseSample | null = null;
  for (const s of samples) {
    if (s.ptsUs >= before) break;
    if (
      Math.abs(s.ptsUs - target) <= tolerance &&
      (!best || Math.abs(s.ptsUs - target) < Math.abs(best.ptsUs - target))
    ) {
      best = s;
    }
  }
  return best;
}

function hipOrBoxCentre(s: PoseSample): readonly [number, number] | null {
  const l = jointPosition(s.player, JOINT.leftHip);
  const r = jointPosition(s.player, JOINT.rightHip);
  if (l && r) return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2];
  const b = s.player.box;
  return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
}

/** Length of the hip path through the samples, in body heights. */
export function hipPathBodyHeights(samples: readonly PoseSample[], bodyHeight: number): number {
  let total = 0;
  let previous: readonly [number, number] | null = null;
  for (const s of samples) {
    const c = hipOrBoxCentre(s);
    if (!c) continue;
    if (previous) total += Math.hypot(c[0] - previous[0], c[1] - previous[1]);
    previous = c;
  }
  return total / bodyHeight;
}

/**
 * Largest distance between two positions of the same wrist across the samples, in body heights. A player who stays
 * put but swings an arm still leaves ghosts that can be told apart (a spike from a close-up), unlike one running on
 * the spot toward the camera whose hands barely move in the image.
 */
export function wristSpanBodyHeights(samples: readonly PoseSample[], bodyHeight: number): number {
  let widest = 0;
  for (const joint of [JOINT.leftWrist, JOINT.rightWrist]) {
    const points: (readonly [number, number])[] = [];
    for (const s of samples) {
      const at = jointPosition(s.player, joint);
      if (at) points.push(at);
    }
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i] as readonly [number, number];
        const b = points[j] as readonly [number, number];
        widest = Math.max(widest, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
    }
  }
  return widest / bodyHeight;
}

/**
 * Chooses the ghosts of the focus player. When neither the hips (path) nor a wrist (span) move more than half a body
 * height across them (a player running toward or away from the camera) the ghosts would pile up on the body, so none
 * are drawn and the result says 'still'.
 */
export function selectGhosts(win: FocusWindow, reduced: boolean): GhostSet {
  const now = win.samples[win.index] as PoseSample;
  const times = ghostTimes(win.nowUs, reduced);
  const tolerance = (GHOST_STEP_S * US) / 2;
  const picked: PoseSample[] = [];
  for (const target of times) {
    const s = nearest(win.samples, target, tolerance, win.nowUs);
    if (s && !picked.includes(s)) picked.push(s);
  }
  if (picked.length < 2) return { status: 'off', ghosts: [] };
  const all = [...picked, now];
  const moved = Math.max(hipPathBodyHeights(all, win.bodyHeight), wristSpanBodyHeights(all, win.bodyHeight));
  if (moved < GHOST_MIN_DISPLACEMENT) return { status: 'still', ghosts: [] };
  const ghosts = picked.map((sample, i) => ({ sample, recency: (i + 1) / picked.length }));
  return { status: 'drawn', ghosts };
}

export interface GhostPaint {
  readonly ctx: Canvas2DContext;
  readonly view: ViewTransform;
  /** Focus bone width W in canvas px. */
  readonly width: number;
  readonly color: Rgb;
  readonly reduced: boolean;
  /** Background brightness 0..1 (FrameStyle.bright). */
  readonly bright?: number;
}

/** Thin, translucent copies of the pose: no joints, no head, tint shifting to blue with age. Oldest first. */
export function paintGhosts(gp: GhostPaint, set: GhostSet): void {
  const { ctx, view } = gp;
  const dpr = view.dpr;
  const bright = gp.bright ?? 0;
  for (const ghost of set.ghosts) {
    const p = preparePlayer(ghost.sample.player, view);
    if (p.assessment.level === 'marker') continue;
    const t = gp.reduced ? 0.6 : ghost.recency;
    // on sand and white walls a pale ghost vanishes: more body, and a darker rim
    const alpha = Math.min(0.85, (0.14 + 0.36 * t) * (1 + 0.7 * bright));
    const colour = mix(gp.color, GHOST_TINT, 0.75 * (1 - t));
    const W = gp.width * GHOST_WIDTH;
    for (const bone of drawnBones(p, 1)) {
      const s = BONE_STYLES[bone.index];
      if (!s) continue;
      const ax = p.points[s.def.a * 2] as number;
      const ay = p.points[s.def.a * 2 + 1] as number;
      const bx = p.points[s.def.b * 2] as number;
      const by = p.points[s.def.b * 2 + 1] as number;
      // a faint dark rim keeps a light ghost readable on sand without making it look like a second player
      ctx.beginPath();
      roundConePath(ctx, ax, ay, (W * s.r0) / 2 + dpr * (1 + bright), bx, by, (W * s.r1) / 2 + dpr * (1 + bright));
      ctx.fillStyle = rgba(CASING, (0.3 + 0.35 * bright) * alpha * bone.alpha);
      ctx.fill();
      ctx.beginPath();
      roundConePath(ctx, ax, ay, (W * s.r0) / 2, bx, by, (W * s.r1) / 2);
      ctx.fillStyle = rgba(colour, alpha * bone.alpha);
      ctx.fill();
    }
  }
}
