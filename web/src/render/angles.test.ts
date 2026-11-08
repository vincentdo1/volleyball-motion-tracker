import { describe, expect, it } from 'vitest';
import {
  type Canvas2DContext,
  containTransform,
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
} from '@/contracts/renderer';
import { type AngleLabel, ELBOW_RIGHT, hittingArm, measureAngles, paintAngleLabels } from './angles';
import { LabelPlacer } from './chips';
import { buildFocusWindow } from './focus';
import { prepareFor } from './focus-testing';
import { createFrameSource } from './frame-source';
import { createSkeletonRenderer } from './renderer';
import { motionScene } from './testing';

const R_SHOULDER = 6;
const R_ELBOW = 8;
const R_WRIST = 10;
const L_WRIST = 9;

/** Right arm bent at exactly 90 degrees: shoulder above the elbow, wrist to the side of it. */
const bent = {
  [R_SHOULDER]: () => [400, 300] as const,
  [R_ELBOW]: () => [400, 360] as const,
  [R_WRIST]: () => [460, 360] as const,
};

function frameOf(scene: ReturnType<typeof motionScene>, index: number) {
  const f = createFrameSource(scene).frameAt(index);
  return { f, p: prepareFor(f.players[0]) };
}

describe('angle measurement', () => {
  it('measures the interior angle at the vertex in degrees', () => {
    const { p } = frameOf(motionScene({ fps: 30, seconds: 1, joints: bent }), 10);
    const elbow = measureAngles(p, ELBOW_RIGHT).find((a) => a.spec.name === 'elbow');
    expect(elbow?.degrees).toBeCloseTo(90, 3);
    expect(elbow?.approximate).toBe(false);
  });

  it('shows an angle only when all three joints score at least 0.6', () => {
    const at = (score: number) => {
      const scene = motionScene({ fps: 30, seconds: 1, joints: bent, scores: { [R_WRIST]: () => score } });
      const { p } = frameOf(scene, 10);
      return measureAngles(p, ELBOW_RIGHT).filter((a) => a.spec.name === 'elbow');
    };
    expect(at(0.59)).toHaveLength(0);
    expect(at(0.61)).toHaveLength(1);
  });

  it('measures both knees when their joints are confident', () => {
    const { p } = frameOf(motionScene({ fps: 30, seconds: 1 }), 10);
    const names = measureAngles(p, hittingArm(null, p)).map((a) => a.spec.name);
    expect(names).toContain('knee-left');
    expect(names).toContain('knee-right');
    for (const a of measureAngles(p, hittingArm(null, p))) {
      if (a.spec.name !== 'elbow') expect(a.degrees).toBeGreaterThan(165);
    }
  });

  it('prefixes "~" when a bone is foreshortened below 0.7x its local reference', () => {
    // the forearm is 60 px except for a dip to 25 px around 1.5 s; the median of +-15 samples stays at 60
    const dip = (t: number) => (t > 1.4 && t < 1.6 ? 25 : 60);
    const scene = motionScene({
      fps: 30,
      seconds: 3,
      joints: {
        ...bent,
        [R_WRIST]: (t) => [400 + dip(t), 360] as const,
      },
    });
    const normal = frameOf(scene, 30);
    const short = frameOf(scene, 45);
    const find = (p: ReturnType<typeof prepareFor>) =>
      measureAngles(p, ELBOW_RIGHT).find((a) => a.spec.vertex === R_ELBOW);
    expect(find(normal.p)?.approximate).toBe(false);
    expect(find(short.p)?.approximate).toBe(true);
  });

  it('picks the arm whose wrist travelled further as the hitting arm', () => {
    const swing = (t: number) => [440 + 120 * Math.sin(t * 9), 260 - 90 * Math.cos(t * 9)] as const;
    const scene = motionScene({ fps: 30, seconds: 2, joints: { [L_WRIST]: swing } });
    const { f, p } = frameOf(scene, 45);
    const win = buildFocusWindow(f.history, p, f.ptsUs, 0.5, 0.1);
    expect(hittingArm(win, p).vertex).toBe(7);
    const right = motionScene({ fps: 30, seconds: 2, joints: { [R_WRIST]: swing } });
    const r = frameOf(right, 45);
    expect(hittingArm(buildFocusWindow(r.f.history, r.p, r.f.ptsUs, 0.5, 0.1), r.p).vertex).toBe(R_ELBOW);
  });
});

describe('angle labels', () => {
  const ctx = new Proxy({} as Canvas2DContext, {
    get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 30 }) : () => undefined),
    set: () => true,
  });
  const label = (x: number, y: number): AngleLabel => ({ text: '90°', x, y, dx: 1, dy: 0, radius: 20 });

  it('steps outward past a label already placed, and drops one that finds no room', () => {
    const placer = new LabelPlacer();
    expect(paintAngleLabels(ctx, placer, [label(100, 100), label(100, 100)], 1, 400, 400)).toBe(2);
    const crowded = new LabelPlacer();
    // a wall of earlier labels: nothing fits within eight nudges
    for (let x = 0; x < 400; x += 20) for (let y = 0; y < 400; y += 14) crowded.place(x, y, 20, 14, 0, 0);
    expect(paintAngleLabels(ctx, crowded, [label(100, 100)], 1, 400, 400)).toBe(0);
  });
});

describe('angles in the renderer', () => {
  const scene = motionScene({ fps: 30, seconds: 1, joints: bent });
  const frame = createFrameSource(scene).frameAt(10);
  const view = containTransform(1280, 720, 1280, 720, 1);
  const draws = (options: Partial<RenderOptions>) => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Canvas2DContext, {
      get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 20 }) : () => calls.push(String(prop))),
      set: () => true,
    });
    createSkeletonRenderer().draw(ctx, frame, view, {
      ...DEFAULT_RENDER_OPTIONS,
      focusTrackId: 1,
      showFocusTrails: false,
      showBall: false,
      ...options,
    });
    return calls;
  };

  it('is off by default and draws arcs plus value pills when on', () => {
    const off = draws({});
    const on = draws({ showAngles: true });
    expect(on.filter((c) => c === 'fillText').length).toBeGreaterThan(off.filter((c) => c === 'fillText').length);
    expect(on.filter((c) => c === 'arc').length).toBeGreaterThan(off.filter((c) => c === 'arc').length);
  });

  it('draws no angles for players other than the focus', () => {
    expect(draws({ showAngles: true, focusTrackId: null }).filter((c) => c === 'fillText')).toHaveLength(
      draws({ focusTrackId: null }).filter((c) => c === 'fillText').length,
    );
  });
});
