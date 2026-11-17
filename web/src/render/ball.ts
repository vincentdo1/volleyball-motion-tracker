import { BallVisibility } from '@/contracts/posetrack';
import { CASING_COLOR, type Canvas2DContext, type RenderBall, type ViewTransform } from '@/contracts/renderer';
import { hexToRgb, mix, rgba, smoothstep, WHITE } from './color';

const CASING = hexToRgb(CASING_COLOR);
/** The UI accent: violet is absent from the identity palette, so the ball can never be mistaken for a player. */
const BALL_RING = hexToRgb('#8f7bff');
const MIN_RADIUS_CSS_PX = 3;

/** Short dotted trail, oldest first (dots, never a polyline, so a tracker jump shows as a jump). */
export function paintBallTrail(ctx: Canvas2DContext, ball: RenderBall, view: ViewTransform): void {
  const trail = ball.trail;
  if (!trail || trail.length < 4) return;
  const n = trail.length / 2;
  const radius = Math.max(MIN_RADIUS_CSS_PX, ball.radius * view.scale) * view.dpr;
  for (let i = 0; i < n - 1; i++) {
    const t = (i + 1) / n;
    const x = ((trail[i * 2] as number) * view.scale + view.offsetX) * view.dpr;
    const y = ((trail[i * 2 + 1] as number) * view.scale + view.offsetY) * view.dpr;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    const r = radius * (0.25 + 0.45 * t);
    ctx.beginPath();
    ctx.arc(x, y, r + view.dpr, 0, Math.PI * 2);
    ctx.fillStyle = rgba(CASING, 0.35 * t);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(mix(BALL_RING, WHITE, 0.45), 0.12 + 0.55 * t * t);
    ctx.fill();
  }
}

/** Ball marker: white disc on a violet ring when measured, hollow dashed ring when inferred (05 §2.6 honesty). */
export function paintBall(ctx: Canvas2DContext, ball: RenderBall, view: ViewTransform): void {
  const x = (ball.x * view.scale + view.offsetX) * view.dpr;
  const y = (ball.y * view.scale + view.offsetY) * view.dpr;
  if (Number.isNaN(x) || Number.isNaN(y) || ball.visibility === BallVisibility.NONE) return;
  const r = Math.max(MIN_RADIUS_CSS_PX, ball.radius * view.scale) * view.dpr;
  const alpha = 0.55 + 0.45 * smoothstep(0.1, 0.5, ball.confidence);
  const ring = Math.max(1.5, r * 0.28);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r + ring + view.dpr, 0, Math.PI * 2);
  ctx.fillStyle = rgba(CASING, 0.55 * alpha);
  ctx.fill();
  if (ball.visibility === BallVisibility.INFERRED) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.setLineDash([r * 0.7, r * 0.5]);
    ctx.lineWidth = ring;
    ctx.strokeStyle = rgba(BALL_RING, alpha * 0.9);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba([248, 250, 253], alpha);
    ctx.fill();
    ctx.lineWidth = ring;
    ctx.strokeStyle = rgba(BALL_RING, alpha);
    ctx.stroke();
  }
  ctx.restore();
}
