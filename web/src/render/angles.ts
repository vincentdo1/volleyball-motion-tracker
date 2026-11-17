import { CASING_COLOR, type Canvas2DContext } from '@/contracts/renderer';
import { BONE_STYLES } from './bones';
import { FONT_STACK, type LabelPlacer } from './chips';
import { clamp, hexToRgb, rgba, WHITE } from './color';
import type { FocusWindow } from './focus';
import { JOINT, jointPosition } from './kinematics';
import type { PreparedPlayer } from './prepare';

const CASING = hexToRgb(CASING_COLOR);
/** All three joints of an angle must score at least this (05 §2.10). */
export const ANGLE_MIN_SCORE = 0.6;
/** A bone shorter than this fraction of its local reference length is foreshortened: its 2D angle is unreliable. */
export const FORESHORTEN_RATIO = 0.7;
/** Seconds of wrist travel that decide which arm is the hitting arm. */
export const HITTING_ARM_WINDOW_S = 0.5;

export type AngleName = 'elbow' | 'knee-left' | 'knee-right';

export interface AngleSpec {
  readonly name: AngleName;
  readonly a: number;
  readonly vertex: number;
  readonly b: number;
  /** RENDER_BONES indices of the two bones (for the foreshortening check and the gate). */
  readonly boneA: string;
  readonly boneB: string;
}

export const ELBOW_LEFT: AngleSpec = {
  name: 'elbow',
  a: JOINT.leftShoulder,
  vertex: JOINT.leftElbow,
  b: JOINT.leftWrist,
  boneA: 'left_upper_arm',
  boneB: 'left_forearm',
};
export const ELBOW_RIGHT: AngleSpec = {
  name: 'elbow',
  a: JOINT.rightShoulder,
  vertex: JOINT.rightElbow,
  b: JOINT.rightWrist,
  boneA: 'right_upper_arm',
  boneB: 'right_forearm',
};
const KNEE_LEFT: AngleSpec = {
  name: 'knee-left',
  a: JOINT.leftHip,
  vertex: JOINT.leftKnee,
  b: JOINT.leftAnkle,
  boneA: 'left_thigh',
  boneB: 'left_shin',
};
const KNEE_RIGHT: AngleSpec = {
  name: 'knee-right',
  a: JOINT.rightHip,
  vertex: JOINT.rightKnee,
  b: JOINT.rightAnkle,
  boneA: 'right_thigh',
  boneB: 'right_shin',
};

const boneIndex = (name: string): number => BONE_STYLES.findIndex((b) => b.def.name === name);

/** Path length of a wrist over the window, display px. Only measured steps count. */
function wristTravel(win: FocusWindow, joint: number): number {
  let total = 0;
  let previous: readonly [number, number] | null = null;
  for (const sample of win.samples) {
    if (win.nowUs - sample.ptsUs > HITTING_ARM_WINDOW_S * 1e6 || sample.ptsUs > win.nowUs) continue;
    const at = jointPosition(sample.player, joint);
    if (at && previous) total += Math.hypot(at[0] - previous[0], at[1] - previous[1]);
    previous = at;
  }
  return total;
}

/**
 * The hitting arm: the one whose wrist travelled further over the last half second (the swing), else the one held
 * higher. Without any history only the second rule applies.
 */
export function hittingArm(win: FocusWindow | null, p: PreparedPlayer): AngleSpec {
  if (win) {
    const left = wristTravel(win, JOINT.leftWrist);
    const right = wristTravel(win, JOINT.rightWrist);
    if (Math.abs(left - right) > 0.15 * win.bodyHeight) return left > right ? ELBOW_LEFT : ELBOW_RIGHT;
  }
  const ly = p.points[JOINT.leftWrist * 2 + 1] as number;
  const ry = p.points[JOINT.rightWrist * 2 + 1] as number;
  return Number.isNaN(ry) || ly < ry ? ELBOW_LEFT : ELBOW_RIGHT;
}

export interface MeasuredAngle {
  readonly spec: AngleSpec;
  readonly degrees: number;
  /** Bone foreshortened below 0.7x its reference: shown with a "~". */
  readonly approximate: boolean;
  /** Canvas px. */
  readonly vertex: readonly [number, number];
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly shorterBone: number;
}

function jointAt(p: PreparedPlayer, j: number): readonly [number, number] {
  return [p.points[j * 2] as number, p.points[j * 2 + 1] as number];
}

/** The angles of the focus player that can be shown now: all three joints >= 0.6 and both bones passing the gate. */
export function measureAngles(p: PreparedPlayer, arm: AngleSpec): MeasuredAngle[] {
  const kp = p.player.keypoints;
  if (!kp) return [];
  const out: MeasuredAngle[] = [];
  for (const spec of [arm, KNEE_LEFT, KNEE_RIGHT]) {
    const score = (j: number) => kp[j * 3 + 2] as number;
    if (
      !(score(spec.a) >= ANGLE_MIN_SCORE && score(spec.vertex) >= ANGLE_MIN_SCORE && score(spec.b) >= ANGLE_MIN_SCORE)
    )
      continue;
    const bi = boneIndex(spec.boneA);
    const bj = boneIndex(spec.boneB);
    if (!p.assessment.boneOk[bi] || !p.assessment.boneOk[bj]) continue;
    const v = jointAt(p, spec.vertex);
    const a = jointAt(p, spec.a);
    const b = jointAt(p, spec.b);
    const la = Math.hypot(a[0] - v[0], a[1] - v[1]);
    const lb = Math.hypot(b[0] - v[0], b[1] - v[1]);
    if (!(la > 0 && lb > 0)) continue;
    const cos = ((a[0] - v[0]) * (b[0] - v[0]) + (a[1] - v[1]) * (b[1] - v[1])) / (la * lb);
    const degrees = (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI;
    const ref = p.player.refBoneLengths;
    const short = (idx: number, lengthCanvas: number): boolean => {
      const r = ref?.[idx] ?? 0;
      return r > 0 && lengthCanvas / p.pxScale < FORESHORTEN_RATIO * r;
    };
    out.push({
      spec,
      degrees,
      approximate: short(bi, la) || short(bj, lb),
      vertex: v,
      from: a,
      to: b,
      shorterBone: Math.min(la, lb),
    });
  }
  return out;
}

export interface AngleLabel {
  readonly text: string;
  /** Anchor on the arc, canvas px, and the unit vector pointing away from the body. */
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly radius: number;
}

function bodyCentre(p: PreparedPlayer): readonly [number, number] {
  const pts = [JOINT.leftShoulder, JOINT.rightShoulder, JOINT.leftHip, JOINT.rightHip].map((j) => jointAt(p, j));
  const ok = pts.filter((q) => !Number.isNaN(q[0]));
  if (ok.length >= 2) {
    return [ok.reduce((s, q) => s + q[0], 0) / ok.length, ok.reduce((s, q) => s + q[1], 0) / ok.length];
  }
  const b = p.bounds;
  return b ? [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] : [0, 0];
}

/** Wedge at 20 % of the identity colour plus an arc stroke; returns the label requests to place later. */
export function paintAngleArcs(
  ctx: Canvas2DContext,
  p: PreparedPlayer,
  angles: readonly MeasuredAngle[],
  width: number,
  dpr: number,
): AngleLabel[] {
  const labels: AngleLabel[] = [];
  const centre = bodyCentre(p);
  for (const angle of angles) {
    const [vx, vy] = angle.vertex;
    const radius = clamp(0.32 * angle.shorterBone, 10 * dpr, 56 * dpr);
    const a1 = Math.atan2(angle.from[1] - vy, angle.from[0] - vx);
    const a2 = Math.atan2(angle.to[1] - vy, angle.to[0] - vx);
    let diff = a2 - a1;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff <= -Math.PI) diff += 2 * Math.PI;
    const ccw = diff < 0;
    const stroke = Math.max(1.5 * dpr, 0.24 * width);
    ctx.beginPath();
    ctx.moveTo(vx, vy);
    ctx.arc(vx, vy, radius, a1, a2, ccw);
    ctx.closePath();
    ctx.fillStyle = rgba(p.color, 0.2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(vx, vy, radius, a1, a2, ccw);
    ctx.lineCap = 'round';
    ctx.lineWidth = stroke + 2 * Math.max(1, dpr);
    ctx.strokeStyle = rgba(CASING, 0.7);
    ctx.stroke();
    ctx.lineWidth = stroke;
    ctx.strokeStyle = rgba(p.color, 1);
    ctx.stroke();
    // the label sits outward from the body centre through the vertex (05 §2.10)
    let dx = vx - centre[0];
    let dy = vy - centre[1];
    const norm = Math.hypot(dx, dy);
    if (norm < 1e-3) {
      dx = 0;
      dy = -1;
    } else {
      dx /= norm;
      dy /= norm;
    }
    labels.push({ text: `${angle.approximate ? '~' : ''}${Math.round(angle.degrees)}°`, x: vx, y: vy, dx, dy, radius });
  }
  return labels;
}

/**
 * Pills for the angle values. They go through the same placer as the name chips (place those first), step outward and
 * are dropped when they would overlap another label.
 */
export function paintAngleLabels(
  ctx: Canvas2DContext,
  placer: LabelPlacer,
  labels: readonly AngleLabel[],
  dpr: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const fontPx = Math.round(11 * dpr);
  ctx.font = `650 ${fontPx}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let drawn = 0;
  for (const label of labels) {
    const w = ctx.measureText(label.text).width + fontPx * 1.1;
    const h = fontPx * 1.6;
    const reach = label.radius + h * 0.7 + 3 * dpr;
    const cx = clamp(label.x + label.dx * (reach + w * 0.25 * Math.abs(label.dx)), w / 2 + 3, canvasWidth - w / 2 - 3);
    const cy = clamp(label.y + label.dy * reach, h / 2 + 3, canvasHeight - h / 2 - 3);
    const at = placer.place(cx, cy, w, h, label.dx, label.dy);
    if (!at) continue;
    ctx.beginPath();
    ctx.roundRect(at[0] - w / 2, at[1] - h / 2, w, h, h / 2);
    ctx.fillStyle = 'rgba(8,11,16,0.86)';
    ctx.fill();
    ctx.lineWidth = dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.stroke();
    ctx.fillStyle = rgba(WHITE, 1);
    ctx.fillText(label.text, at[0], at[1] + fontPx * 0.04);
    drawn++;
  }
  return drawn;
}
