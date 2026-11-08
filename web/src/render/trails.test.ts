import { describe, expect, it } from 'vitest';
import { KeypointFlag } from '@/contracts/posetrack';
import {
  type Canvas2DContext,
  containTransform,
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
} from '@/contracts/renderer';
import { buildFocusWindow } from './focus';
import { prepareFor } from './focus-testing';
import { createFrameSource } from './frame-source';
import { createSkeletonRenderer } from './renderer';
import { motionScene } from './testing';
import { comPath, wristDots } from './trails';

const RIGHT_WRIST = 10;
const LEFT_WRIST = 9;
/** The test body is 280 px tall, so 1.5 body-heights/s is 420 px/s. */

function windowAt(scene: ReturnType<typeof motionScene>, frame: number, backS = 0.5) {
  const f = createFrameSource(scene).frameAt(frame);
  const win = buildFocusWindow(f.history, prepareFor(f.players[0]), f.ptsUs, backS, 0.1);
  if (!win) throw new Error('no window');
  return win;
}

const fast = (t: number) => [600 + 900 * t, 300 - 200 * Math.sin(t * 4)] as const; // about 3.3 body-heights/s

describe('wrist comet dots', () => {
  it('draws dots where the wrist is fast, newest first', () => {
    const scene = motionScene({ fps: 30, seconds: 2, joints: { [RIGHT_WRIST]: fast } });
    const dots = wristDots(windowAt(scene, 45), RIGHT_WRIST, 0.5);
    expect(dots.length).toBeGreaterThanOrEqual(8);
    expect(dots.length).toBeLessThanOrEqual(10);
    expect(dots[0]?.recency).toBeGreaterThan(dots[dots.length - 1]?.recency ?? 1);
    expect(dots.every((d) => d.speed > 1.5)).toBe(true);
  });

  it('leaves out low-speed jitter (speed gate 1.5 body-heights/s)', () => {
    const jitter = (t: number) => [560 + 6 * Math.sin(t * 40), 260 + 6 * Math.cos(t * 37)] as const;
    const scene = motionScene({ fps: 30, seconds: 2, joints: { [RIGHT_WRIST]: jitter } });
    expect(wristDots(windowAt(scene, 45), RIGHT_WRIST, 0.5)).toHaveLength(0);
  });

  it('does not depend on the frame rate', () => {
    const at = (fps: number) =>
      wristDots(
        windowAt(motionScene({ fps, seconds: 2, joints: { [RIGHT_WRIST]: fast } }), fps * 1.5),
        RIGHT_WRIST,
        0.5,
      );
    const a = at(30);
    const b = at(60);
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
    expect(a[0]?.recency).toBeCloseTo(b[0]?.recency ?? 0, 1);
  });

  it('breaks the trail at an L/R swap repair', () => {
    const swapped = (t: number, joint: number) =>
      joint === RIGHT_WRIST && t > 0.99 && t < 1.07 ? KeypointFlag.SWAP_REPAIRED : 0;
    const scene = motionScene({ fps: 30, seconds: 2, joints: { [RIGHT_WRIST]: fast }, flags: swapped });
    const clean = motionScene({ fps: 30, seconds: 2, joints: { [RIGHT_WRIST]: fast } });
    const dots = wristDots(windowAt(scene, 45), RIGHT_WRIST, 0.5);
    // frame 45 is 1.5 s; the repaired frames lie 0.43 to 0.5 s back: the dots stop short of the window's end
    expect(dots.length).toBeGreaterThanOrEqual(5);
    expect(dots.length).toBeLessThan(wristDots(windowAt(clean, 45), RIGHT_WRIST, 0.5).length);
    expect(Math.min(...dots.map((d) => d.recency))).toBeGreaterThan(0.1);
  });

  it('draws nothing when the current frame is itself repaired', () => {
    const scene = motionScene({
      fps: 30,
      seconds: 2,
      joints: { [RIGHT_WRIST]: fast },
      flags: (_t, joint) => (joint === RIGHT_WRIST ? KeypointFlag.SWAP_REPAIRED : 0),
    });
    expect(wristDots(windowAt(scene, 45), RIGHT_WRIST, 0.5)).toHaveLength(0);
  });

  it('shortens to the window it is given (reduced motion, 0.2 s)', () => {
    const scene = motionScene({ fps: 30, seconds: 2, joints: { [RIGHT_WRIST]: fast } });
    const dots = wristDots(windowAt(scene, 45, 0.2), RIGHT_WRIST, 0.2);
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.length).toBeLessThanOrEqual(4);
  });

  it('ignores the other wrist when only one moves', () => {
    const scene = motionScene({ fps: 30, seconds: 2, joints: { [RIGHT_WRIST]: fast } });
    expect(wristDots(windowAt(scene, 45), LEFT_WRIST, 0.5)).toHaveLength(0);
  });
});

describe('centre-of-mass path', () => {
  it('follows the hips back over the window, newest first', () => {
    const scene = motionScene({ fps: 30, seconds: 2, body: (t) => [100 * t, -40 * Math.sin(t * 3)] });
    const path = comPath(windowAt(scene, 45), 0.5);
    expect(path.length).toBe(16);
    expect((path[0]?.[0] ?? 0) > (path[path.length - 1]?.[0] ?? 0)).toBe(true);
  });

  it('stops at a jump longer than 0.22 body heights', () => {
    // 280 px tall: a 100 px step exceeds 0.22 * 280 = 62 px
    const scene = motionScene({ fps: 30, seconds: 2, body: (t) => [t > 1.3 ? 100 : 0, 0] });
    const path = comPath(windowAt(scene, 45), 0.5);
    expect(path.length).toBeGreaterThan(2);
    expect(path.length).toBeLessThan(10);
    expect(path.every((p) => p[0] === path[0]?.[0])).toBe(true);
  });

  it('stops where a hip is unmeasured', () => {
    const scene = motionScene({
      fps: 30,
      seconds: 2,
      scores: { 11: (t) => (t > 1.2 && t < 1.3 ? 0.1 : 0.9) },
    });
    const path = comPath(windowAt(scene, 45), 0.5);
    expect(path.length).toBeLessThan(8);
    expect(path.length).toBeGreaterThan(2);
  });
});

describe('trails in the renderer', () => {
  const scene = motionScene({ fps: 30, seconds: 2, joints: { [RIGHT_WRIST]: fast }, body: (t) => [80 * t, 0] });
  const source = createFrameSource(scene);
  const view = containTransform(1280, 720, 1280, 720, 1);

  const count = (options: Partial<RenderOptions>, withHistory = true, without: (keyof RenderOptions)[] = []) => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Canvas2DContext, {
      get: (_t, prop) =>
        prop === 'measureText' ? () => ({ width: 12 }) : (...args: unknown[]) => calls.push(`${String(prop)}`) && args,
      set: () => true,
    });
    const frame = source.frameAt(45);
    const full: Record<string, unknown> = {
      ...DEFAULT_RENDER_OPTIONS,
      focusTrackId: 1,
      showChips: false,
      showBall: false,
      ...options,
    };
    for (const key of without) delete full[key];
    createSkeletonRenderer().draw(ctx, withHistory ? frame : { ...frame, history: undefined }, view, full as never);
    return calls.filter((c) => c === 'arc').length;
  };

  it('draws dots and a path for the focus player by default', () => {
    expect(count({})).toBeGreaterThan(count({ showFocusTrails: false }));
  });

  it('treats an absent option as on, and draws nothing extra without history or focus', () => {
    expect(count({}, true, ['showFocusTrails', 'showGhosts', 'showAngles', 'velocityColor', 'reducedMotion'])).toBe(
      count({}),
    );
    expect(count({}, false)).toBe(count({ showFocusTrails: false }));
    expect(count({ focusTrackId: null })).toBe(count({ focusTrackId: null, showFocusTrails: false }));
  });

  it('uses fewer dots under reduced motion', () => {
    expect(count({ reducedMotion: true })).toBeLessThan(count({}));
  });
});
