import { HALPE26_SIGMAS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { RenderPlayer, SkeletonLevel } from '@/contracts/renderer';
import { BODY_BONE_INDICES, BONE_STYLES, J } from './bones';

/** Joint score below which a bone is dropped (05 §2.6). */
export const BONE_MIN_SCORE = 0.35;
/** Both torso ends must clear this to trust the torso at all. */
export const TORSO_MIN_SCORE = 0.5;
/** A bone longer than this multiple of the track's own median length is a swap/jump glitch. */
const REF_LENGTH_FACTOR = 1.6;
/** Share of confident keypoints that must sit inside the detector box (whole-pose check a). */
const INSIDE_BOX_SHARE = 0.8;
const BOX_MARGIN = 0.15;
const APPARENT_HEIGHT_RANGE = [0.6, 1.5] as const;
const SHOULDER_TORSO_RANGE = [0.25, 1.3] as const;
const DUPLICATE_OKS = 0.5;
const DUPLICATE_IOU = 0.6;

export interface PoseAssessment {
  readonly level: Exclude<SkeletonLevel, 'hidden'>;
  /** Per RENDER_BONES index: bone passed the plausibility gate and may be drawn. */
  readonly boneOk: boolean[];
  /** Mid-shoulder to mid-hip distance in display px (0 when unknown). */
  readonly torsoLength: number;
  /** Apparent height in display px: max(confident y-extent, 3.2 x torso). 0 for a box-only player. */
  readonly apparentHeight: number;
}

function kpScore(kp: Float32Array, joint: number): number {
  const s = kp[joint * 3 + 2] as number;
  return Number.isNaN(s) ? 0 : s;
}

function pairDistance(kp: Float32Array, a: number, b: number): number {
  return Math.hypot(
    (kp[a * 3] as number) - (kp[b * 3] as number),
    (kp[a * 3 + 1] as number) - (kp[b * 3 + 1] as number),
  );
}

/** Mid-point of two joints with the weaker score, or null when either coordinate is missing. */
function midpoint(kp: Float32Array, a: number, b: number): { x: number; y: number; score: number } | null {
  const x = ((kp[a * 3] as number) + (kp[b * 3] as number)) / 2;
  const y = ((kp[a * 3 + 1] as number) + (kp[b * 3 + 1] as number)) / 2;
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return { x, y, score: Math.min(kpScore(kp, a), kpScore(kp, b)) };
}

export function torsoLengthOf(kp: Float32Array): number {
  const sh = midpoint(kp, J.leftShoulder, J.rightShoulder);
  const hp = midpoint(kp, J.leftHip, J.rightHip);
  return sh && hp ? Math.hypot(sh.x - hp.x, sh.y - hp.y) : 0;
}

/** Vertical extent of keypoints above `minScore`, 0 when fewer than two qualify. */
function confidentYExtent(kp: Float32Array, minScore: number): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < PERSON_KP_VALUES / 3; j++) {
    if (kpScore(kp, j) <= minScore) continue;
    const y = kp[j * 3 + 1] as number;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return hi > lo ? hi - lo : 0;
}

/** Whole-pose checks (05 §2.6 a, b, d). A pose failing any of them is demoted to a marker for the frame. */
function wholePoseOk(kp: Float32Array, box: RenderPlayer['box'], torso: number, apparent: number): boolean {
  if (box) {
    const [x0, y0, x1, y1] = box;
    const mx = (x1 - x0) * BOX_MARGIN;
    const my = (y1 - y0) * BOX_MARGIN;
    let confident = 0;
    let inside = 0;
    for (let j = 0; j < PERSON_KP_VALUES / 3; j++) {
      if (kpScore(kp, j) <= BONE_MIN_SCORE) continue;
      confident++;
      const x = kp[j * 3] as number;
      const y = kp[j * 3 + 1] as number;
      if (x >= x0 - mx && x <= x1 + mx && y >= y0 - my && y <= y1 + my) inside++;
    }
    if (confident > 0 && inside / confident < INSIDE_BOX_SHARE) return false;
    const boxHeight = y1 - y0;
    if (boxHeight > 0) {
      const ratio = apparent / boxHeight;
      if (ratio < APPARENT_HEIGHT_RANGE[0] || ratio > APPARENT_HEIGHT_RANGE[1]) return false;
    }
  }
  if (torso > 0) {
    const ratio = pairDistance(kp, J.leftShoulder, J.rightShoulder) / torso;
    if (ratio < SHOULDER_TORSO_RANGE[0] || ratio > SHOULDER_TORSO_RANGE[1]) return false;
  }
  return true;
}

/**
 * Plausibility gate, whole-pose checks and the degradation ladder for one player (05 §2.6). Gated bones are never
 * drawn: `boneOk[i]` is the only authority for whether bone i may appear.
 */
export function assessPose(player: RenderPlayer): PoseAssessment {
  const kp = player.keypoints;
  const boneOk = new Array<boolean>(BONE_STYLES.length).fill(false);
  if (!kp) return { level: 'marker', boneOk, torsoLength: 0, apparentHeight: 0 };

  const sh = midpoint(kp, J.leftShoulder, J.rightShoulder);
  const hp = midpoint(kp, J.leftHip, J.rightHip);
  const torsoTrusted = sh !== null && hp !== null && sh.score > TORSO_MIN_SCORE && hp.score > TORSO_MIN_SCORE;
  const torso = sh && hp ? Math.hypot(sh.x - hp.x, sh.y - hp.y) : 0;
  const apparent = Math.max(confidentYExtent(kp, 0.3), torso * 3.2);

  for (const i of BODY_BONE_INDICES) {
    const style = BONE_STYLES[i];
    if (!style) continue;
    const { a, b } = style.def;
    if (kpScore(kp, a) < BONE_MIN_SCORE || kpScore(kp, b) < BONE_MIN_SCORE) continue;
    const length = pairDistance(kp, a, b);
    if (Number.isNaN(length)) continue;
    if (torsoTrusted && torso > 4 && length > style.maxTorso * torso) continue;
    const ref = player.refBoneLengths?.[i] ?? 0;
    if (ref > 0 && length > REF_LENGTH_FACTOR * ref) continue;
    boneOk[i] = true;
  }

  let torsoBones = 0;
  let limbs = 0;
  for (const i of BODY_BONE_INDICES) {
    if (!boneOk[i]) continue;
    const kind = BONE_STYLES[i]?.def.kind;
    if (kind === 'torso') torsoBones++;
    else if (kind === 'limb') limbs++;
  }
  let level: PoseAssessment['level'] = 'marker';
  if (torsoTrusted && torsoBones >= 3 && wholePoseOk(kp, player.box, torso, apparent)) {
    level = limbs >= 5 ? 'full' : limbs >= 1 ? 'partial' : 'torso';
  }
  if (level === 'marker') boneOk.fill(false);
  return { level, boneOk, torsoLength: torso, apparentHeight: apparent };
}

/** Intersection over union of two [x0, y0, x1, y1] boxes. */
export function boxIou(a: readonly number[], b: readonly number[]): number {
  const w = Math.min(a[2] as number, b[2] as number) - Math.max(a[0] as number, b[0] as number);
  const h = Math.min(a[3] as number, b[3] as number) - Math.max(a[1] as number, b[1] as number);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const area = (r: readonly number[]) => ((r[2] as number) - (r[0] as number)) * ((r[3] as number) - (r[1] as number));
  return inter / (area(a) + area(b) - inter);
}

/** Object keypoint similarity of two poses; the object scale is the larger pose's keypoint-extent area. */
export function poseOks(a: Float32Array, b: Float32Array): number {
  const extent = (kp: Float32Array) => {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < PERSON_KP_VALUES / 3; j++) {
      if (kpScore(kp, j) <= BONE_MIN_SCORE) continue;
      x0 = Math.min(x0, kp[j * 3] as number);
      x1 = Math.max(x1, kp[j * 3] as number);
      y0 = Math.min(y0, kp[j * 3 + 1] as number);
      y1 = Math.max(y1, kp[j * 3 + 1] as number);
    }
    return Number.isFinite(x0) ? (x1 - x0) * (y1 - y0) : 0;
  };
  const area = Math.max(extent(a), extent(b));
  if (area <= 0) return 0;
  let sum = 0;
  let n = 0;
  for (let j = 0; j < PERSON_KP_VALUES / 3; j++) {
    if (kpScore(a, j) <= BONE_MIN_SCORE || kpScore(b, j) <= BONE_MIN_SCORE) continue;
    const d2 = (a[j * 3] as number) - (b[j * 3] as number);
    const e2 = (a[j * 3 + 1] as number) - (b[j * 3 + 1] as number);
    const k = 2 * (HALPE26_SIGMAS[j] as number);
    sum += Math.exp(-(d2 * d2 + e2 * e2) / (2 * area * k * k));
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Duplicate suppression (05 §2.6 e): two poses with OKS > 0.5 or box IoU > 0.6 are the same person. Returns the
 * indices (into `players`) of the lower-scoring duplicates, which the renderer must not draw.
 */
export function findDuplicates(players: readonly RenderPlayer[]): Set<number> {
  const dropped = new Set<number>();
  for (let i = 0; i < players.length; i++) {
    const p = players[i] as RenderPlayer;
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < players.length; j++) {
      const q = players[j] as RenderPlayer;
      if (dropped.has(j)) continue;
      const sameBox = p.box && q.box ? boxIou(p.box, q.box) > DUPLICATE_IOU : false;
      const samePose = p.keypoints && q.keypoints ? poseOks(p.keypoints, q.keypoints) > DUPLICATE_OKS : false;
      if (!sameBox && !samePose) continue;
      // keep the higher-scoring pose; on a tie the lower track id (the older identity) wins
      const keepP = p.boxScore > q.boxScore || (p.boxScore === q.boxScore && p.trackId <= q.trackId);
      dropped.add(keepP ? j : i);
      if (!keepP) break;
    }
  }
  return dropped;
}
