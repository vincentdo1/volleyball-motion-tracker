import { CASING_COLOR, type Canvas2DContext } from '@/contracts/renderer';
import { clamp, hexToRgb, rgba } from './color';
import type { PreparedPlayer } from './prepare';
import type { PlayerRole } from './skeleton';

const CASING = hexToRgb(CASING_COLOR);
export const FONT_STACK = '"Geist Variable", "Geist", system-ui, sans-serif';
/** Players shorter than this many CSS px get a dot instead of a chip (05 §2.10). */
const TINY_CSS_PX = 60;
const MAX_NUDGES = 8;
const GAP = 3;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Greedy label placement (05 §2.10): a label that overlaps an earlier one steps outward up to 8 times and is then
 * dropped rather than drawn on top. Place the focus player's chip first so it always wins.
 */
export class LabelPlacer {
  private readonly placed: Rect[] = [];

  reset(): void {
    this.placed.length = 0;
  }

  place(cx: number, cy: number, w: number, h: number, stepX: number, stepY: number): [number, number] | null {
    let x = cx;
    let y = cy;
    for (let i = 0; i < MAX_NUDGES; i++) {
      const rect = { x: x - w / 2, y: y - h / 2, w, h };
      const clash = this.placed.some(
        (q) =>
          rect.x < q.x + q.w + GAP &&
          rect.x + rect.w + GAP > q.x &&
          rect.y < q.y + q.h + GAP &&
          rect.y + rect.h + GAP > q.y,
      );
      if (!clash) {
        this.placed.push(rect);
        return [x, y];
      }
      x += stepX * h * 0.8;
      y += stepY * h * 0.8;
    }
    return null;
  }
}

export function paintChip(
  ctx: Canvas2DContext,
  placer: LabelPlacer,
  p: PreparedPlayer,
  role: PlayerRole,
  dpr: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const area = p.bounds;
  if (!area) return;
  const focus = role === 'focus';
  const fontPx = Math.round((focus ? 12.5 : 11) * dpr);
  const ax = (area.x0 + area.x1) / 2;
  const top = area.y0;
  const color = p.color;

  if (p.height < TINY_CSS_PX * dpr && !focus) {
    const at = placer.place(ax, top - 6 * dpr, 7 * dpr, 7 * dpr, 0, -1);
    if (!at) return;
    ctx.beginPath();
    ctx.arc(at[0], at[1], 3.2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, 0.95);
    ctx.fill();
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeStyle = rgba(CASING, 0.8);
    ctx.stroke();
    return;
  }

  ctx.font = `650 ${fontPx}px ${FONT_STACK}`;
  const label = p.player.label;
  const textWidth = ctx.measureText(label).width;
  const h = fontPx * 1.75;
  const dot = fontPx * 0.36;
  const w = textWidth + fontPx * 1.25 + dot * 2.4;
  const cx = clamp(ax, w / 2 + 4, canvasWidth - w / 2 - 4);
  const cy = clamp(top - h * 1.05, h / 2 + 4, canvasHeight - h / 2 - 4);
  const at = placer.place(cx, cy, w, h, 0, -1);
  if (!at) return;
  const left = at[0] - w / 2;
  const topEdge = at[1] - h / 2;
  const inactive = role === 'context';
  ctx.beginPath();
  ctx.roundRect(left, topEdge, w, h, h / 2);
  ctx.fillStyle = focus ? 'rgba(8,11,16,0.9)' : 'rgba(8,11,16,0.68)';
  ctx.fill();
  ctx.lineWidth = (focus ? 1.5 : 1) * dpr;
  ctx.strokeStyle = rgba(color, focus ? 1 : inactive ? 0.5 : 0.6);
  ctx.stroke();
  if (p.reusedColor) {
    // second cue for a reused hue: an inner ring
    ctx.beginPath();
    ctx.roundRect(left + 2.5 * dpr, topEdge + 2.5 * dpr, w - 5 * dpr, h - 5 * dpr, (h - 5 * dpr) / 2);
    ctx.lineWidth = dpr;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(left + fontPx * 0.62 + dot, at[1], dot, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 1);
  ctx.fill();
  ctx.fillStyle = focus ? '#ffffff' : '#dfe6ee';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, left + fontPx * 0.62 + dot * 2.5, at[1] + fontPx * 0.05);
}
