import type { Canvas2DContext, ViewTransform } from '@/contracts/renderer';
import { FONT_STACK, type LabelPlacer } from './chips';
import { clamp, hexToRgb, mix, type Rgb, rgba, WHITE } from './color';
import type { FocusWindow } from './focus';
import { BODY_JOINTS, JOINT, jointSpeedPx, velMaxOf } from './kinematics';

/** Speed ramp (05 §2.9): starts at neutral so slow bones recede and cannot be mistaken for a cyan identity. */
export const RAMP: readonly { readonly at: number; readonly color: Rgb }[] = [
  { at: 0, color: hexToRgb('#8a93a3') },
  { at: 0.3, color: hexToRgb('#28dcff') },
  { at: 0.55, color: hexToRgb('#b4ff5a') },
  { at: 0.78, color: hexToRgb('#ffc828') },
  { at: 1, color: hexToRgb('#ff3c78') },
];

/** Colour of a normalised speed 0..1. */
export function rampColor(t: number): Rgb {
  const x = clamp(Number.isNaN(t) ? 0 : t, 0, 1);
  for (let i = 1; i < RAMP.length; i++) {
    const hi = RAMP[i] as (typeof RAMP)[number];
    if (x <= hi.at) {
      const lo = RAMP[i - 1] as (typeof RAMP)[number];
      return mix(lo.color, hi.color, (x - lo.at) / (hi.at - lo.at));
    }
  }
  return (RAMP[RAMP.length - 1] as (typeof RAMP)[number]).color;
}

/** Foot joints take the colour of the ankle they hang from. */
const FOOT_PARENT: Readonly<Record<number, number>> = {
  20: JOINT.leftAnkle,
  22: JOINT.leftAnkle,
  24: JOINT.leftAnkle,
  21: JOINT.rightAnkle,
  23: JOINT.rightAnkle,
  25: JOINT.rightAnkle,
};

export interface VelocityColors {
  /** Largest speed of the ramp, body-heights per second. */
  readonly velMax: number;
  /** Per joint speed in body-heights per second, NaN when unmeasured. */
  readonly speeds: Float32Array;
  colorOf(joint: number): Rgb;
  /** Head and neck follow the shoulders. */
  readonly headColor: Rgb;
}

/** Joint speeds at the current frame, normalised by the player's apparent height and so independent of fps. */
export function velocityColors(win: FocusWindow): VelocityColors {
  const velMax = velMaxOf(win.history.wristSpeedP95(win.prepared.player.trackId));
  const speeds = new Float32Array(26).fill(Number.NaN);
  for (const joint of BODY_JOINTS) {
    const px = jointSpeedPx(win.samples, win.index, joint);
    if (px !== null) speeds[joint] = px / win.bodyHeight;
  }
  const colors = new Map<number, Rgb>();
  const neutral = rampColor(0);
  const colorOf = (joint: number): Rgb => {
    const j = FOOT_PARENT[joint] ?? joint;
    let c = colors.get(j);
    if (!c) {
      const s = speeds[j] as number;
      c = Number.isNaN(s) ? neutral : rampColor(s / velMax);
      colors.set(j, c);
    }
    return c;
  };
  return { velMax, speeds, colorOf, headColor: mix(colorOf(JOINT.leftShoulder), colorOf(JOINT.rightShoulder), 0.5) };
}

/** Linear gradient between two colours along a bone, or null when the context cannot make one. */
export function boneGradient(
  ctx: Canvas2DContext,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  a: Rgb,
  b: Rgb,
  alpha: number,
): CanvasGradient | null {
  const gradient = ctx.createLinearGradient(ax, ay, bx, by) as CanvasGradient | undefined;
  if (!gradient) return null;
  gradient.addColorStop(0, rgba(a, alpha));
  gradient.addColorStop(1, rgba(b, alpha));
  return gradient;
}

/** Legend chip at the bottom left of the video: the ramp and its absolute scale, so auto-scaling never hides magnitudes. */
export function paintVelocityLegend(
  ctx: Canvas2DContext,
  placer: LabelPlacer,
  velMax: number,
  view: ViewTransform,
): void {
  const dpr = view.dpr;
  const fontPx = Math.round(11 * dpr);
  const text = `0 to ${velMax.toFixed(1)} body-heights/s`;
  ctx.font = `650 ${fontPx}px ${FONT_STACK}`;
  const bar = 54 * dpr;
  const barH = 6 * dpr;
  const padding = fontPx * 0.7;
  const w = padding * 2 + bar + fontPx * 0.6 + ctx.measureText(text).width;
  const h = fontPx * 1.9;
  const cx = view.offsetX * dpr + 12 * dpr + w / 2;
  const cy = view.canvasHeight - view.offsetY * dpr - 12 * dpr - h / 2;
  const at = placer.place(cx, cy, w, h, 0, -1);
  if (!at) return;
  const left = at[0] - w / 2;
  ctx.beginPath();
  ctx.roundRect(left, at[1] - h / 2, w, h, h / 2);
  ctx.fillStyle = 'rgba(8,11,16,0.86)';
  ctx.fill();
  ctx.lineWidth = dpr;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.stroke();
  const x0 = left + padding;
  const gradient = ctx.createLinearGradient(x0, 0, x0 + bar, 0) as CanvasGradient | undefined;
  if (gradient) {
    for (const stop of RAMP) gradient.addColorStop(stop.at, rgba(stop.color, 1));
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = rgba(rampColor(0.5), 1);
  }
  ctx.beginPath();
  ctx.roundRect(x0, at[1] - barH / 2, bar, barH, barH / 2);
  ctx.fill();
  ctx.fillStyle = rgba(WHITE, 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x0 + bar + fontPx * 0.6, at[1] + fontPx * 0.04);
}
