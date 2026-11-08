import { KeypointFlag } from '@/contracts/posetrack';
import { CASING_COLOR, type Canvas2DContext, type RenderOptions } from '@/contracts/renderer';
import { BEAD_JOINTS, BODY_BONE_INDICES, BONE_STYLES, J } from './bones';
import { hexToRgb, mix, type Rgb, rgba, smoothstep, WHITE } from './color';
import { circlePath, roundConePath } from './geometry';
import type { HaloQueue } from './halo';
import { baseWidth, type PreparedPlayer } from './prepare';
import {
  CONF_FULL,
  CONF_SHOW,
  CONTEXT_DESATURATE,
  CONTEXT_GREY,
  CONTEXT_WIDTH,
  CORE_MIX,
  CORE_WIDTH,
  FOCUS_WIDTH,
  type FrameStyle,
  INTERPOLATED_ALPHA,
  LEFT_LIGHTEN,
  SIDE_CENTER,
  SIDE_LEFT,
  SIDE_RIGHT,
} from './style';
import { boneGradient, type VelocityColors } from './velocity';

const CASING = hexToRgb(CASING_COLOR);
const JOINT_FILL: Rgb = [245, 248, 252];
const MIN_BONE_ALPHA = 0.02;

/** How a player is drawn relative to the focus selection. */
export type PlayerRole = 'plain' | 'focus' | 'context';

export interface PaintContext {
  readonly ctx: Canvas2DContext;
  readonly style: FrameStyle;
  readonly options: RenderOptions;
  readonly dpr: number;
  /** Collects glowing limbs, or null when glow is off. */
  readonly halos: HaloQueue | null;
  /** Speed colours for the focus player (velocity mode); absent = identity colours. */
  readonly velocity?: VelocityColors | null;
}

export function widthFor(pc: PaintContext, p: PreparedPlayer, role: PlayerRole): number {
  const w = baseWidth(p.height, pc.style.widthK);
  return role === 'focus' ? w * FOCUS_WIDTH : role === 'context' ? w * CONTEXT_WIDTH : w;
}

function jointAlpha(p: PreparedPlayer, joint: number): number {
  const kp = p.player.keypoints;
  if (!kp) return 0;
  const score = kp[joint * 3 + 2] as number;
  if (Number.isNaN(score)) return 0;
  const alpha = smoothstep(CONF_SHOW, CONF_FULL, score);
  const interpolated = ((p.player.kpFlags?.[joint] ?? 0) & KeypointFlag.INTERPOLATED) !== 0;
  return interpolated ? alpha * INTERPOLATED_ALPHA : alpha;
}

function isInterpolated(p: PreparedPlayer, joint: number): boolean {
  return ((p.player.kpFlags?.[joint] ?? 0) & KeypointFlag.INTERPOLATED) !== 0;
}

function identityColor(p: PreparedPlayer, role: PlayerRole): Rgb {
  return role === 'context' ? mix(p.color, CONTEXT_GREY, CONTEXT_DESATURATE) : p.color;
}

function boneColor(side: 'L' | 'R' | 'C', base: Rgb, sideMode: boolean): Rgb {
  if (sideMode) return side === 'L' ? SIDE_LEFT : side === 'R' ? SIDE_RIGHT : SIDE_CENTER;
  return side === 'L' ? mix(base, WHITE, LEFT_LIGHTEN) : base;
}

export interface DrawnBone {
  readonly index: number;
  readonly alpha: number;
  readonly dashed: boolean;
}

export function drawnBones(p: PreparedPlayer, alphaScale: number): DrawnBone[] {
  const out: DrawnBone[] = [];
  // torso first, then limbs and feet, so limbs overlap the torso outline
  const order = [...BODY_BONE_INDICES].sort(
    (a, b) => Number(BONE_STYLES[a]?.def.kind !== 'torso') - Number(BONE_STYLES[b]?.def.kind !== 'torso'),
  );
  for (const index of order) {
    if (!p.assessment.boneOk[index]) continue;
    const def = BONE_STYLES[index]?.def;
    if (!def) continue;
    const alpha = Math.min(jointAlpha(p, def.a), jointAlpha(p, def.b)) * alphaScale;
    if (alpha < MIN_BONE_ALPHA) continue;
    out.push({ index, alpha, dashed: isInterpolated(p, def.a) || isInterpolated(p, def.b) });
  }
  return out;
}

function point(p: PreparedPlayer, joint: number): [number, number] {
  return [p.points[joint * 2] as number, p.points[joint * 2 + 1] as number];
}

/** Draws one player at the `full`, `partial` or `torso` ladder level. Marker players go through `paintMarker`. */
export function paintSkeleton(pc: PaintContext, p: PreparedPlayer, role: PlayerRole): void {
  const { ctx, style } = pc;
  const W = widthFor(pc, p, role);
  const alphaScale = role === 'context' ? style.contextAlpha : 1;
  const bones = drawnBones(p, alphaScale);
  const base = identityColor(p, role);
  const sideMode = pc.options.colorMode === 'side' && role !== 'context';
  const casingPx = Math.max(style.casingMinPx * pc.dpr, W * style.casingExtra);
  const glowing = pc.halos !== null && role !== 'context';
  const vel = role === 'focus' ? (pc.velocity ?? null) : null;

  ctx.save();
  ctx.lineCap = 'round';

  // pass 1: dark casing under every bone (never optional: it is what makes any hue readable on sand)
  ctx.fillStyle = rgba(CASING, 1);
  for (const bone of bones) {
    const s = BONE_STYLES[bone.index];
    if (!s) continue;
    const [ax, ay] = point(p, s.def.a);
    const [bx, by] = point(p, s.def.b);
    if (bone.dashed) {
      ctx.setLineDash([W * 1.6, W * 1.2]);
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(1, W * 0.35) + 2 * casingPx * 0.6;
      ctx.strokeStyle = rgba(CASING, style.casingAlpha * bone.alpha);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
      continue;
    }
    ctx.beginPath();
    roundConePath(ctx, ax, ay, (W * s.r0) / 2 + casingPx, bx, by, (W * s.r1) / 2 + casingPx);
    ctx.fillStyle = rgba(CASING, style.casingAlpha * bone.alpha);
    ctx.fill();
  }

  paintHead(pc, p, W, vel ? vel.headColor : base);

  // pass 2: colour fill, bright core line and glow source
  for (const bone of bones) {
    const s = BONE_STYLES[bone.index];
    if (!s) continue;
    const [ax, ay] = point(p, s.def.a);
    const [bx, by] = point(p, s.def.b);
    const velA = vel?.colorOf(s.def.a);
    const velB = vel?.colorOf(s.def.b);
    const color = velA && velB ? mix(velA, velB, 0.5) : boneColor(s.def.side, base, sideMode);
    if (bone.dashed) {
      // inferred, not measured: a thin dashed line (05 §2.6)
      ctx.setLineDash([W * 1.6, W * 1.2]);
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(1, W * 0.35);
      ctx.strokeStyle = rgba(color, bone.alpha);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
      continue;
    }
    ctx.beginPath();
    roundConePath(ctx, ax, ay, (W * s.r0) / 2, bx, by, (W * s.r1) / 2);
    ctx.fillStyle =
      (velA && velB ? boneGradient(ctx, ax, ay, bx, by, velA, velB, bone.alpha) : null) ?? rgba(color, bone.alpha);
    ctx.fill();
    if (style.coreAlpha > 0.02 && role !== 'context' && W > 3) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineWidth = W * CORE_WIDTH * Math.min(s.r0, s.r1);
      ctx.strokeStyle = rgba(vel ? WHITE : mix(color, WHITE, CORE_MIX), style.coreAlpha * bone.alpha);
      ctx.stroke();
    }
    if (glowing && pc.halos && s.def.kind !== 'torso') {
      pc.halos.add(ax, ay, W * s.r0 * 0.5, bx, by, W * s.r1 * 0.5, color, bone.alpha);
    }
  }

  // pass 3: joint beads, only on joints that belong to a drawn bone; context players stay bare
  if (pc.options.showJoints && role !== 'context') {
    const attached = new Set<number>();
    for (const bone of bones) {
      const def = BONE_STYLES[bone.index]?.def;
      if (def) {
        attached.add(def.a);
        attached.add(def.b);
      }
    }
    const r = Math.max(1.4 * pc.dpr, W * 0.42);
    for (const joint of BEAD_JOINTS) {
      if (!attached.has(joint)) continue;
      const alpha = jointAlpha(p, joint);
      if (alpha < 0.05) continue;
      const [x, y] = point(p, joint);
      ctx.beginPath();
      circlePath(ctx, x, y, r + Math.max(1, W * 0.18));
      ctx.fillStyle = rgba(CASING, 0.7 * alpha);
      ctx.fill();
      ctx.beginPath();
      circlePath(ctx, x, y, r);
      if (isInterpolated(p, joint)) {
        // hollow ring = inferred joint
        ctx.lineWidth = Math.max(1, r * 0.4);
        ctx.strokeStyle = rgba(JOINT_FILL, alpha);
        ctx.stroke();
      } else {
        ctx.fillStyle = rgba(JOINT_FILL, alpha);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** Head circle between the ears (nose fallback) plus a neck line; no face points (05 §2.2). */
function paintHead(pc: PaintContext, p: PreparedPlayer, W: number, color: Rgb): void {
  const { ctx } = pc;
  const kp = p.player.keypoints;
  if (!kp) return;
  const score = (j: number) => (kp[j * 3 + 2] as number) || 0;
  const earsOk = score(J.leftEar) > 0.3 && score(J.rightEar) > 0.3;
  const noseOk = score(J.nose) > 0.3;
  if (!earsOk && !noseOk) return;
  const [lx, ly] = point(p, J.leftEar);
  const [rx, ry] = point(p, J.rightEar);
  const [nx, ny] = point(p, J.nose);
  const cx = earsOk ? (lx + rx) / 2 : nx;
  const cy = earsOk ? (ly + ry) / 2 : ny;
  const [lsx, lsy] = point(p, J.leftShoulder);
  const [rsx, rsy] = point(p, J.rightShoulder);
  const shoulderWidth = Math.hypot(lsx - rsx, lsy - rsy);
  const msx = (lsx + rsx) / 2;
  const msy = (lsy + rsy) / 2;
  const alpha = (earsOk ? Math.min(jointAlpha(p, J.leftEar), jointAlpha(p, J.rightEar)) : jointAlpha(p, J.nose)) || 0;
  if (alpha < 0.05 || Number.isNaN(msx) || Number.isNaN(cx)) return;
  const radius = Math.max(W * 1.1, earsOk ? Math.hypot(lx - rx, ly - ry) * 0.62 : shoulderWidth * 0.26);
  // a head further from the shoulders than the torso is long belongs to someone else
  const torsoPx = p.assessment.torsoLength * p.pxScale;
  if (torsoPx > 0 && Math.hypot(cx - msx, cy - msy) > 1.6 * torsoPx + radius) return;
  const angle = Math.atan2(cy - msy, cx - msx);
  const ex = cx - Math.cos(angle) * radius;
  const ey = cy - Math.sin(angle) * radius;
  const lineWidth = Math.max(1.2, W * 0.42);
  const casing = 2 * Math.max(1.2, W * 0.2);
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(msx, msy);
    ctx.lineTo(ex, ey);
    circlePath(ctx, cx, cy, radius);
    if (p.reusedColor) circlePath(ctx, cx, cy, radius + lineWidth * 1.8);
  };
  ctx.lineCap = 'round';
  trace();
  ctx.lineWidth = lineWidth + casing;
  ctx.strokeStyle = rgba(CASING, 0.6 * alpha);
  ctx.stroke();
  trace();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = rgba(color, alpha);
  ctx.stroke();
}

/** Marker level: a dashed identity-colour ring at the detector box centre (or the confident-joint centre). */
export function paintMarker(pc: PaintContext, p: PreparedPlayer, role: PlayerRole): void {
  const area = p.box ?? p.bounds;
  if (!area) return;
  const { ctx } = pc;
  const W = widthFor(pc, p, role);
  const r = Math.max(5 * pc.dpr, W * 1.4);
  const cx = (area.x0 + area.x1) / 2;
  const cy = (area.y0 + area.y1) / 2;
  const base = identityColor(p, role);
  ctx.save();
  ctx.globalAlpha = (role === 'context' ? pc.style.contextAlpha : 1) * 0.9;
  ctx.beginPath();
  circlePath(ctx, cx, cy, r);
  ctx.lineWidth = Math.max(2.2, W * 0.5) + 2 * pc.dpr;
  ctx.strokeStyle = rgba(CASING, 0.6);
  ctx.stroke();
  ctx.setLineDash([3 * pc.dpr, 3 * pc.dpr]);
  ctx.lineWidth = Math.max(1.5, W * 0.5);
  ctx.strokeStyle = rgba(base, 1);
  ctx.stroke();
  if (p.reusedColor) {
    ctx.beginPath();
    circlePath(ctx, cx, cy, r + 3 * pc.dpr);
    ctx.stroke();
  }
  ctx.restore();
}
