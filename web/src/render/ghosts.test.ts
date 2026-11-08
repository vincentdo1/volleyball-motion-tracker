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
import { GHOST_COUNT, GHOST_REACH_S, ghostTimes, selectGhosts } from './ghosts';
import { createSkeletonRenderer } from './renderer';
import { motionScene } from './testing';

function windowAt(scene: ReturnType<typeof motionScene>, frame: number) {
  const f = createFrameSource(scene).frameAt(frame);
  const win = buildFocusWindow(f.history, prepareFor(f.players[0]), f.ptsUs, GHOST_REACH_S, 0.1);
  if (!win) throw new Error('no window');
  return win;
}

describe('ghost times', () => {
  it('are six, oldest first, 0.12 s apart', () => {
    const times = ghostTimes(2_000_000, false);
    expect(times).toHaveLength(GHOST_COUNT);
    expect(times[GHOST_COUNT - 1]).toBe(2_000_000 - 120_000);
    expect((times[1] as number) - (times[0] as number)).toBe(120_000);
  });

  it('are fixed snapshots under reduced motion: the set does not slide with the playhead', () => {
    const a = ghostTimes(2_000_000, true);
    const b = ghostTimes(2_030_000, true);
    expect(a.length).toBeGreaterThan(0);
    // same block of 0.72 s: whatever both show is at identical times
    const shared = a.filter((t) => b.includes(t));
    expect(shared.length).toBe(Math.min(a.length, b.length));
    expect(ghostTimes(2_000_000, true).every((t) => t < 2_000_000)).toBe(true);
  });
});

describe('ghost selection and the displacement rule', () => {
  it('draws ghosts while the hips travel across the frame', () => {
    // 280 px tall body running sideways at 400 px/s: 0.7 s covers about one body height
    const scene = motionScene({ fps: 30, seconds: 3, body: (t) => [400 * t, 0] });
    const set = selectGhosts(windowAt(scene, 60), false);
    expect(set.status).toBe('drawn');
    expect(set.ghosts).toHaveLength(GHOST_COUNT);
    expect(set.ghosts[0]?.recency).toBeLessThan(set.ghosts[GHOST_COUNT - 1]?.recency ?? 0);
  });

  it('is the same at 60 fps as at 30 fps', () => {
    const at = (fps: number) =>
      selectGhosts(windowAt(motionScene({ fps, seconds: 3, body: (t) => [400 * t, 0] }), fps * 2), false);
    const slow = at(30).ghosts.map((g) => g.sample.ptsUs);
    const fast = at(60).ghosts.map((g) => g.sample.ptsUs);
    expect(fast).toHaveLength(slow.length);
    // the same moments within half a frame of the slower clip
    for (const [i, t] of fast.entries()) expect(Math.abs(t - (slow[i] as number))).toBeLessThanOrEqual(17_000);
  });

  it('draws none for a player standing still: they would stack on the body', () => {
    const set = selectGhosts(windowAt(motionScene({ fps: 30, seconds: 3 }), 60), false);
    expect(set.status).toBe('still');
    expect(set.ghosts).toHaveLength(0);
  });

  it('draws none while a player runs on the spot toward the camera (hips barely move in the image)', () => {
    const scene = motionScene({ fps: 30, seconds: 3, body: (t) => [3 * Math.sin(t * 5), 4 * Math.sin(t * 7)] });
    expect(selectGhosts(windowAt(scene, 60), false).status).toBe('still');
  });

  it('draws ghosts for a player who stays put but swings an arm across more than half a body height', () => {
    const swing = (t: number) => [440 + 220 * Math.sin(t * 9), 330 - 200 * Math.cos(t * 9)] as const;
    const scene = motionScene({ fps: 30, seconds: 3, joints: { 10: swing } });
    expect(selectGhosts(windowAt(scene, 60), false).status).toBe('drawn');
  });

  it('draws what exists at the start of a clip', () => {
    const scene = motionScene({ fps: 30, seconds: 3, body: (t) => [400 * t, 0] });
    const set = selectGhosts(windowAt(scene, 9), false);
    expect(set.ghosts.length).toBeLessThan(GHOST_COUNT);
  });
});

describe('ghosts in the renderer', () => {
  const scene = motionScene({ fps: 30, seconds: 3, body: (t) => [400 * t, 0] });
  const frame = createFrameSource(scene).frameAt(60);
  const view = containTransform(1920, 1080, 1920, 1080, 1);
  const run = (options: Partial<RenderOptions>) => {
    let fills = 0;
    const ctx = new Proxy({} as Canvas2DContext, {
      get: (_t, prop) =>
        prop === 'measureText' ? () => ({ width: 20 }) : () => (prop === 'fill' ? fills++ : undefined),
      set: () => true,
    });
    const stats = createSkeletonRenderer().draw(ctx, frame, view, {
      ...DEFAULT_RENDER_OPTIONS,
      focusTrackId: 1,
      showFocusTrails: false,
      showBall: false,
      ...options,
    });
    return { fills, stats };
  };

  it('are off by default and reported as drawn when on', () => {
    const off = run({});
    const on = run({ showGhosts: true });
    expect(off.stats.focus?.ghosts).toBe('off');
    expect(on.stats.focus?.ghosts).toBe('drawn');
    expect(on.fills).toBeGreaterThan(off.fills);
  });

  it('are never drawn for a player who is not the focus', () => {
    expect(run({ showGhosts: true, focusTrackId: null }).stats.focus?.ghosts).toBe('off');
  });
});
