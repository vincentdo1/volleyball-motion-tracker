import type { Canvas2DContext } from '@/contracts/renderer';
import { type Rgb, rgba } from './color';
import { roundConePath } from './geometry';

/** Concentric halo layers: radius multiplier on the bone radius and alpha at strength 1. */
const HALO_LAYERS: ReadonlyArray<readonly [radius: number, alpha: number]> = [
  [5.6, 0.04],
  [3.9, 0.06],
  [2.7, 0.09],
  [1.8, 0.15],
];

interface HaloBone {
  readonly ax: number;
  readonly ay: number;
  readonly ra: number;
  readonly bx: number;
  readonly by: number;
  readonly rb: number;
  readonly color: Rgb;
  readonly alpha: number;
}

/**
 * Bloom (05 §2.7): limbs get soft additive halos. They are queued while the skeletons are drawn and painted in one
 * `lighter` pass afterwards, widest layer first, so the glow sits over everything yet never washes out the cores.
 * Concentric fills on the main canvas avoid `ctx.filter` blur (slow, unsupported in Safari) and any offscreen
 * layer round trips, which dominated frame time at 4K.
 */
export class HaloQueue {
  private readonly bones: HaloBone[] = [];

  get size(): number {
    return this.bones.length;
  }

  add(ax: number, ay: number, ra: number, bx: number, by: number, rb: number, color: Rgb, alpha: number): void {
    this.bones.push({ ax, ay, ra, bx, by, rb, color, alpha });
  }

  clear(): void {
    this.bones.length = 0;
  }

  paint(ctx: Canvas2DContext, strength: number): void {
    if (this.bones.length === 0 || strength <= 0.02) {
      this.clear();
      return;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [radius, alpha] of HALO_LAYERS) {
      for (const b of this.bones) {
        ctx.beginPath();
        roundConePath(ctx, b.ax, b.ay, b.ra * radius, b.bx, b.by, b.rb * radius);
        ctx.fillStyle = rgba(b.color, alpha * strength * b.alpha);
        ctx.fill();
      }
    }
    ctx.restore();
    this.clear();
  }
}
