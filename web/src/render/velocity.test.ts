import { describe, expect, it } from 'vitest';
import {
  type Canvas2DContext,
  containTransform,
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
} from '@/contracts/renderer';
import { buildFocusWindow } from './focus';
import { prepareFor } from './focus-testing';
import { createFrameSource } from './frame-source';
import { velMaxOf } from './kinematics';
import { createSkeletonRenderer } from './renderer';
import { motionScene } from './testing';
import { RAMP, rampColor, velocityColors } from './velocity';

const R_WRIST = 10;
const fast = (t: number) => [600 + 900 * t, 300] as const; // 900 px/s on a 280 px body: about 3.2 body-heights/s

function colorsAt(fps: number, frame: number) {
  const scene = motionScene({ fps, seconds: 2, joints: { [R_WRIST]: fast } });
  const f = createFrameSource(scene).frameAt(frame);
  const win = buildFocusWindow(f.history, prepareFor(f.players[0]), f.ptsUs, 0.1, 0.1);
  if (!win) throw new Error('no window');
  return velocityColors(win);
}

describe('speed ramp', () => {
  it('hits the spec stops and clamps outside 0..1', () => {
    expect(rampColor(0)).toEqual([138, 147, 163]);
    expect(rampColor(0.3)).toEqual([40, 220, 255]);
    expect(rampColor(0.55)).toEqual([180, 255, 90]);
    expect(rampColor(0.78)).toEqual([255, 200, 40]);
    expect(rampColor(1)).toEqual([255, 60, 120]);
    expect(rampColor(-3)).toEqual(rampColor(0));
    expect(rampColor(9)).toEqual(rampColor(1));
    expect(rampColor(Number.NaN)).toEqual(rampColor(0));
    expect(RAMP).toHaveLength(5);
  });

  it('starts at neutral grey, not at an identity cyan', () => {
    const [r, g, b] = rampColor(0);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(40);
  });
});

describe('velMax rule', () => {
  it('is at least 4 body-heights/s, else the 95th percentile of the wrist speed', () => {
    expect(velMaxOf(null)).toBe(4);
    expect(velMaxOf(2.5)).toBe(4);
    expect(velMaxOf(7.2)).toBe(7.2);
  });
});

describe('joint speed colours', () => {
  it('colours the moving wrist hot and still joints neutral', () => {
    const c = colorsAt(30, 45);
    expect(c.speeds[R_WRIST]).toBeGreaterThan(3);
    expect(c.colorOf(R_WRIST)).not.toEqual(rampColor(0));
    expect(c.speeds[13]).toBeCloseTo(0, 3);
    expect(c.colorOf(13)).toEqual(rampColor(0));
  });

  it('measures the same speed at 30 and 60 fps (body-heights per second, not per frame)', () => {
    const a = colorsAt(30, 45).speeds[R_WRIST] as number;
    const b = colorsAt(60, 90).speeds[R_WRIST] as number;
    expect(Math.abs(a - b) / a).toBeLessThan(0.02);
  });

  it('colours foot joints like their ankle', () => {
    const c = colorsAt(30, 45);
    expect(c.colorOf(20)).toEqual(c.colorOf(15));
    expect(c.colorOf(25)).toEqual(c.colorOf(16));
  });
});

describe('velocity mode in the renderer', () => {
  const scene = motionScene({ fps: 30, seconds: 2, joints: { [R_WRIST]: fast } });
  const frame = createFrameSource(scene).frameAt(45);
  const view = containTransform(1280, 720, 1280, 720, 1);
  const run = (options: Partial<RenderOptions>) => {
    const texts: string[] = [];
    const gradients: number[] = [];
    const ctx = new Proxy({} as Canvas2DContext, {
      get: (_t, prop) => {
        if (prop === 'measureText') return () => ({ width: 40 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop: () => gradients.push(1) });
        if (prop === 'fillText') return (text: string) => texts.push(text);
        return () => undefined;
      },
      set: () => true,
    });
    createSkeletonRenderer().draw(ctx, frame, view, {
      ...DEFAULT_RENDER_OPTIONS,
      focusTrackId: 1,
      showFocusTrails: false,
      showChips: false,
      showBall: false,
      ...options,
    });
    return { texts, gradients: gradients.length };
  };

  it('is off by default', () => {
    const off = run({});
    expect(off.texts.some((t) => t.includes('body-heights/s'))).toBe(false);
    expect(off.gradients).toBe(0);
  });

  it('shows the absolute scale in a legend and colours bones with gradients when on', () => {
    const on = run({ velocityColor: true });
    expect(on.texts.find((t) => t.includes('body-heights/s'))).toMatch(/^0 to \d+\.\d body-heights\/s$/);
    expect(on.gradients).toBeGreaterThan(5);
  });

  it('colours only the focus player', () => {
    expect(run({ velocityColor: true, focusTrackId: null }).texts.some((t) => t.includes('body-heights'))).toBe(false);
  });
});
