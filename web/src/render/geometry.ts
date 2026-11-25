import type { Canvas2DContext } from '@/contracts/renderer';

/** Adds a tapered capsule ("round cone", the convex hull of two circles) to the current path. */
export function roundConePath(
  ctx: Canvas2DContext,
  ax: number,
  ay: number,
  ra: number,
  bx: number,
  by: number,
  rb: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const d = Math.hypot(dx, dy);
  if (d < 1e-3 || d <= Math.abs(ra - rb)) {
    // one circle swallows the other
    const [cx, cy, r] = ra >= rb ? [ax, ay, ra] : [bx, by, rb];
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    return;
  }
  const angle = Math.atan2(dy, dx);
  const offset = Math.acos((ra - rb) / d);
  ctx.moveTo(ax + ra * Math.cos(angle + offset), ay + ra * Math.sin(angle + offset));
  ctx.arc(ax, ay, ra, angle + offset, angle - offset + Math.PI * 2, false);
  ctx.arc(bx, by, rb, angle - offset, angle + offset, false);
  ctx.closePath();
}

export function circlePath(ctx: Canvas2DContext, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}
