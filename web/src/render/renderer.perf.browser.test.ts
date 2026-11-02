import { describe, expect, it } from 'vitest';
import { containTransform, DEFAULT_RENDER_OPTIONS } from '@/contracts/renderer';
import { createFrameSource } from './frame-source';
import { createSkeletonRenderer } from './index';
import { syntheticScene } from './synthetic';

const WIDTH = 3840;
const HEIGHT = 2160;
const FRAMES = 300;
const WARMUP = 40;
const P95_BUDGET_MS = 4;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
}

describe('renderer performance (4K canvas, 12 players, every layer)', () => {
  it('draws with p95 <= 4 ms per frame', () => {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    const renderer = createSkeletonRenderer();
    const source = createFrameSource(
      syntheticScene({ width: WIDTH, height: HEIGHT, fps: 60, frameCount: 120, players: 12, seed: 3 }),
    );
    const view = containTransform(WIDTH, HEIGHT, WIDTH, HEIGHT, 1);
    const options = { ...DEFAULT_RENDER_OPTIONS, focusTrackId: 1, bgLuma: 0.4 };
    const issue: number[] = [];
    const wall: number[] = [];
    for (let i = 0; i < WARMUP + FRAMES; i++) {
      const frame = source.frameAt(i % 120);
      const t0 = performance.now();
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      const stats = renderer.draw(ctx, frame, view, options);
      // a 1 px readback forces the canvas to flush, so wall time includes rasterisation, not just recording
      ctx.getImageData(WIDTH >> 1, HEIGHT >> 1, 1, 1);
      const elapsed = performance.now() - t0;
      if (i >= WARMUP) {
        issue.push(stats.drawMs);
        wall.push(elapsed);
      }
    }
    const report = {
      recordP50: percentile(issue, 0.5),
      recordP95: percentile(issue, 0.95),
      flushedP50: percentile(wall, 0.5),
      flushedP95: percentile(wall, 0.95),
    };
    console.warn(`perf 3840x2160 x12 players: ${JSON.stringify(report)}`);
    renderer.dispose();
    expect(report.flushedP95).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
