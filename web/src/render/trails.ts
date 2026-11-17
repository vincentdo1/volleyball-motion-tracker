import { CASING_COLOR, type Canvas2DContext, type ViewTransform } from '@/contracts/renderer';
import { hexToRgb, mix, type Rgb, rgba, WHITE } from './color';
import { type FocusWindow, MAX_GAP_S } from './focus';
import { circlePath } from './geometry';
import { isSwapRepaired, JOINT, jointPosition, jointSpeedPx } from './kinematics';
import { SIDE_LEFT, SIDE_RIGHT } from './style';

const CASING = hexToRgb(CASING_COLOR);
const US = 1e6;
/** Spacing of the comet dots in time: about ten dots over 0.5 s, whatever the frame rate. */
export const DOT_STEP_S = 0.05;
/** A dot is drawn only where the wrist moves faster than this many body-heights per second (05 §2.9). */
export const WRIST_SPEED_GATE = 1.5;
/** A centre-of-mass step longer than this fraction of the body height is a jump, not motion (05 §2.9). */
export const COM_STEP_MAX = 0.22;

export interface WristDot {
  readonly joint: number;
  /** Display px. */
  readonly x: number;
  readonly y: number;
  /** 0 (oldest end of the window) to 1 (now). */
  readonly recency: number;
  /** Body-heights per second. */
  readonly speed: number;
}

/**
 * Time-sampled dots of one wrist over the last `windowS` seconds. The walk goes back from the current frame and stops
 * at the first sample where the wrist is unmeasured, L/R repaired or too far in time from the previous one, so a swap
 * ends the trail instead of drawing a streak across it. Dots under the speed gate are left out.
 */
export function wristDots(win: FocusWindow, joint: number, windowS: number): WristDot[] {
  const dots: WristDot[] = [];
  const now = win.samples[win.index] as (typeof win.samples)[number];
  if (isSwapRepaired(now.player, joint) || !jointPosition(now.player, joint)) return dots;
  const steps = Math.round(windowS / DOT_STEP_S);
  let i = win.index;
  let previousPts = now.ptsUs;
  for (let k = 1; k <= steps; k++) {
    const target = win.nowUs - k * DOT_STEP_S * US;
    while (i > 0 && (win.samples[i - 1] as (typeof win.samples)[number]).ptsUs >= target - (DOT_STEP_S * US) / 2) i--;
    const sample = win.samples[i] as (typeof win.samples)[number];
    if (sample.ptsUs >= previousPts) continue; // no new sample since the last dot (low sample rate)
    if (previousPts - sample.ptsUs > MAX_GAP_S * US || Math.abs(sample.ptsUs - target) > DOT_STEP_S * US) break;
    const at = jointPosition(sample.player, joint);
    if (!at || isSwapRepaired(sample.player, joint)) break;
    previousPts = sample.ptsUs;
    const px = jointSpeedPx(win.samples, i, joint);
    if (px === null) continue;
    const speed = px / win.bodyHeight;
    if (speed > WRIST_SPEED_GATE)
      dots.push({ joint, x: at[0], y: at[1], recency: 1 - (k * DOT_STEP_S) / windowS, speed });
  }
  return dots;
}

/** Hip mid-point in display px, or null when either hip is unmeasured. */
function hipCentre(player: FocusWindow['samples'][number]['player']): [number, number] | null {
  const l = jointPosition(player, JOINT.leftHip);
  const r = jointPosition(player, JOINT.rightHip);
  return l && r ? [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2] : null;
}

/**
 * Centre-of-mass path (hip mid-point), newest first, display px. Built by walking back from the current frame and
 * stopping at the first discontinuity: a missing hip, a gap in time, or a step longer than 0.22 body heights.
 */
export function comPath(win: FocusWindow, windowS: number): [number, number][] {
  const now = win.samples[win.index] as (typeof win.samples)[number];
  const first = hipCentre(now.player);
  if (!first) return [];
  const path: [number, number][] = [first];
  let previous = first;
  let previousPts = now.ptsUs;
  for (let i = win.index - 1; i >= 0; i--) {
    const sample = win.samples[i] as (typeof win.samples)[number];
    if (win.nowUs - sample.ptsUs > windowS * US || previousPts - sample.ptsUs > MAX_GAP_S * US) break;
    const c = hipCentre(sample.player);
    if (!c || Math.hypot(c[0] - previous[0], c[1] - previous[1]) > COM_STEP_MAX * win.bodyHeight) break;
    path.push(c);
    previous = c;
    previousPts = sample.ptsUs;
  }
  return path;
}

function toCanvas(view: ViewTransform, x: number, y: number): [number, number] {
  return [(x * view.scale + view.offsetX) * view.dpr, (y * view.scale + view.offsetY) * view.dpr];
}

export interface TrailPaint {
  readonly ctx: Canvas2DContext;
  readonly view: ViewTransform;
  /** Focus bone width W in canvas px. */
  readonly width: number;
  readonly color: Rgb;
  readonly sideMode: boolean;
  /** Background brightness 0..1 (FrameStyle.bright): heavier dark casings on sand and white walls. */
  readonly bright?: number;
}

/** Wrist comets: dots shrinking and fading with age, dark-cased so they read as marks and never as limbs. */
export function paintWristTrails(tp: TrailPaint, win: FocusWindow, windowS: number): number {
  const { ctx, view, width } = tp;
  const bright = tp.bright ?? 0;
  let drawn = 0;
  for (const joint of [JOINT.leftWrist, JOINT.rightWrist]) {
    const base = tp.sideMode ? (joint === JOINT.leftWrist ? SIDE_LEFT : SIDE_RIGHT) : tp.color;
    const fill = mix(base, WHITE, 0.2);
    // oldest first so newer dots sit on top
    const dots = wristDots(win, joint, windowS).reverse();
    for (const dot of dots) {
      const t = dot.recency;
      const r = Math.max(1.2 * view.dpr, width * (0.18 + 0.32 * t));
      // recency fade from the spec; on sand and white walls the dots keep a floor so they never wash out
      const alpha = Math.max(0.25 + 0.6 * t * t, 0.7 * bright);
      const [x, y] = toCanvas(view, dot.x, dot.y);
      ctx.beginPath();
      circlePath(ctx, x, y, r + Math.max(1, 0.22 * r + (0.6 + 0.5 * bright) * view.dpr));
      ctx.fillStyle = rgba(CASING, (0.62 + 0.3 * bright) * alpha);
      ctx.fill();
      ctx.beginPath();
      circlePath(ctx, x, y, r);
      ctx.fillStyle = rgba(fill, alpha);
      ctx.fill();
      drawn++;
    }
  }
  return drawn;
}

/** Dashed white centre-of-mass line with a dark casing; older segments fade. */
export function paintComTrail(tp: TrailPaint, win: FocusWindow, windowS: number): number {
  const path = comPath(win, windowS);
  if (path.length < 2) return 0;
  const { ctx, view, width } = tp;
  const bright = tp.bright ?? 0;
  const line = Math.max(1.4 * view.dpr, width * 0.34);
  const dash = Math.max(3 * view.dpr, width * 1.4);
  const gap = Math.max(2.5 * view.dpr, width * 1.1);
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.setLineDash([dash, gap]);
  let travelled = 0;
  let [px, py] = toCanvas(view, (path[0] as [number, number])[0], (path[0] as [number, number])[1]);
  for (let i = 1; i < path.length; i++) {
    const [x, y] = toCanvas(view, (path[i] as [number, number])[0], (path[i] as [number, number])[1]);
    const age = 1 - i / path.length;
    ctx.lineDashOffset = -travelled;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
    ctx.lineWidth = line + 2 * Math.max(1, view.dpr) * (1 + bright);
    ctx.strokeStyle = rgba(CASING, (0.55 + 0.35 * bright) * (0.35 + 0.65 * age));
    ctx.stroke();
    ctx.lineWidth = line;
    ctx.strokeStyle = rgba(WHITE, 0.35 + 0.55 * age);
    ctx.stroke();
    travelled += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  ctx.restore();
  return path.length - 1;
}
