import { beforeAll, describe, expect, it } from 'vitest';
import rallyJson from '@/contracts/examples/rally.posetrack.json';
import type { PoseTrackDocument } from '@/contracts/posetrack';
import { decodePoseTrack } from '@/contracts/posetrack-codec';
import {
  containTransform,
  DEFAULT_RENDER_OPTIONS,
  type RenderFrame,
  type RenderOptions,
  type SkeletonRenderer,
} from '@/contracts/renderer';
import { createFrameSource } from './frame-source';
import { MAX_DIFFERING_SHARE, matchGolden } from './golden';
import { createSkeletonRenderer } from './index';
import { syntheticScene } from './synthetic';
import { makePlayer, withJoints } from './testing';

const W = 960;
const H = 540;

function stage(background: 'gym' | 'sand'): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const top = background === 'gym' ? '#20252e' : '#e4d6b8';
  const floor = background === 'gym' ? '#3b3226' : '#d9c9a8';
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = floor;
  ctx.fillRect(0, H * 0.55, W, H * 0.45);
  return { canvas, ctx };
}

const view = containTransform(1920, 1080, W, H, 1);
const options = (patch: Partial<RenderOptions> = {}): RenderOptions => ({ ...DEFAULT_RENDER_OPTIONS, ...patch });

let renderer: SkeletonRenderer;
beforeAll(() => {
  renderer = createSkeletonRenderer();
});

const rally = createFrameSource(decodePoseTrack(rallyJson as unknown as PoseTrackDocument));

function alphaAt(ctx: CanvasRenderingContext2D, x: number, y: number): number {
  return ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3] as number;
}

const scene = createFrameSource(
  syntheticScene({ width: 1920, height: 1080, fps: 30, frameCount: 90, players: 5, seed: 11 }),
);

/** View that frames the box of `trackId` at roughly `heightPx` canvas px tall, centred. */
function closeUp(frame: RenderFrame, trackId: number, heightPx: number) {
  const box = frame.players.find((p) => p.trackId === trackId)?.box;
  if (!box) throw new Error('no box');
  const scale = heightPx / (box[3] - box[1]);
  return {
    ...view,
    scale,
    offsetX: W / 2 - ((box[0] + box[2]) / 2) * scale,
    offsetY: H / 2 - ((box[1] + box[3]) / 2) * scale,
  };
}

describe('goldens', () => {
  const cases: [string, 'gym' | 'sand', () => RenderFrame, Partial<RenderOptions>][] = [
    ['rally-identity', 'gym', () => rally.frameAt(5), {}],
    ['rally-focus', 'gym', () => rally.frameAt(5), { focusTrackId: 1 }],
    ['rally-focus-side', 'gym', () => rally.frameAt(5), { focusTrackId: 2, colorMode: 'side' }],
    ['rally-bright-sand', 'sand', () => rally.frameAt(5), { bgLuma: 0.7 }],
    [
      'rally-minimal-layers',
      'gym',
      () => rally.frameAt(5),
      { showJoints: false, showChips: false, showBall: false, glow: 0 },
    ],
  ];
  it('matches scene-wide', async () => {
    const { canvas, ctx } = stage('gym');
    renderer.draw(ctx, scene.frameAt(8), view, options());
    expect(await matchGolden(canvas, 'scene-wide')).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
  });

  it('matches scene-close-up-spike', async () => {
    const { canvas, ctx } = stage('gym');
    const frame = scene.frameAt(8);
    renderer.draw(ctx, frame, closeUp(frame, 1, 440), options({ focusTrackId: 1 }));
    expect(await matchGolden(canvas, 'scene-close-up-spike')).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
  });

  it('matches scene-close-up-sand', async () => {
    const { canvas, ctx } = stage('sand');
    const frame = scene.frameAt(8);
    renderer.draw(ctx, frame, closeUp(frame, 1, 440), options({ bgLuma: 0.7 }));
    expect(await matchGolden(canvas, 'scene-close-up-sand')).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
  });

  for (const [name, bg, frame, patch] of cases) {
    it(`matches ${name}`, async () => {
      const { canvas, ctx } = stage(bg);
      renderer.draw(ctx, frame(), view, options(patch));
      expect(await matchGolden(canvas, name)).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
    });
  }
});

describe('honesty', () => {
  const frameOf = (...players: ReturnType<typeof makePlayer>[]): RenderFrame => ({
    ptsUs: 0,
    frameIndex: 0,
    players,
    ball: null,
  });
  // a 60 x 140 display-px player maps to 30 x 70 canvas px at the contain scale of 0.5
  const px = (x: number, y: number): [number, number] => [x * view.scale + view.offsetX, y * view.scale + view.offsetY];

  it('never draws a gated bone', () => {
    const player = withJoints(makePlayer(1, { box: [400, 300, 520, 700] }), ['left_wrist'], { score: 0.2 });
    const bare = document.createElement('canvas');
    bare.width = W;
    bare.height = H;
    const c = bare.getContext('2d') as CanvasRenderingContext2D;
    renderer.draw(c, frameOf(player), view, options({ showChips: false, glow: 0 }));
    const kp = player.keypoints as Float32Array;
    const mid = (a: number, b: number): [number, number] =>
      px(
        ((kp[a * 3] as number) + (kp[b * 3] as number)) / 2,
        ((kp[a * 3 + 1] as number) + (kp[b * 3 + 1] as number)) / 2,
      );
    const [fx, fy] = mid(7, 9); // left elbow -> left wrist (the gated forearm)
    const [ux, uy] = mid(5, 7); // left shoulder -> left elbow (still drawn)
    expect(alphaAt(c, fx, fy)).toBe(0);
    expect(alphaAt(c, ux, uy)).toBeGreaterThan(200);
  });

  it('draws inferred bones dashed and inferred joints hollow', () => {
    const solid = makePlayer(1, { box: [400, 300, 520, 700] });
    const inferred = makePlayer(1, { box: [400, 300, 520, 700], interpolated: [14, 16] });
    const draw = (p: ReturnType<typeof makePlayer>) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      renderer.draw(ctx, frameOf(p), view, options({ showChips: false, glow: 0 }));
      return ctx;
    };
    const kp = solid.keypoints as Float32Array;
    const [ax, ay] = px(kp[14 * 3] as number, kp[14 * 3 + 1] as number); // right knee
    const [bx, by] = px(kp[16 * 3] as number, kp[16 * 3 + 1] as number); // right ankle
    const coverage = (ctx: CanvasRenderingContext2D) => {
      let hit = 0;
      const steps = 40;
      for (let i = 2; i < steps - 2; i++) {
        const t = i / steps;
        if (alphaAt(ctx, ax + (bx - ax) * t, ay + (by - ay) * t) > 40) hit++;
      }
      return hit / (steps - 4);
    };
    const solidCoverage = coverage(draw(solid));
    const dashedCoverage = coverage(draw(inferred));
    expect(solidCoverage).toBeGreaterThan(0.95);
    expect(dashedCoverage).toBeLessThan(0.85);
    expect(dashedCoverage).toBeGreaterThan(0.2);

    const brightness = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return ((d[0] as number) + (d[1] as number) + (d[2] as number)) / 3;
    };
    const solidCtx = draw(solid);
    const inferredCtx = draw(inferred);
    expect(brightness(solidCtx, ax, ay)).toBeGreaterThan(200);
    expect(brightness(inferredCtx, ax, ay)).toBeLessThan(120);
  });

  it('demotes a composite pose to a marker', () => {
    const composite = withJoints(
      makePlayer(1, { box: [400, 300, 520, 700] }),
      ['right_shoulder', 'right_elbow', 'right_wrist', 'right_hip', 'right_knee', 'right_ankle'],
      { dx: 500 },
    );
    const { ctx } = stage('gym');
    const stats = renderer.draw(ctx, frameOf(composite), view, options());
    expect(stats.levels).toMatchObject({ full: 0, marker: 1 });
  });
});
