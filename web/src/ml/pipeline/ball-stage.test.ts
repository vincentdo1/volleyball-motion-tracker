import type { InferenceSession, Tensor } from 'onnxruntime-common';
import { describe, expect, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import type { BallParams } from '@/contracts/params';
import { BALL_CLIP_LENGTH, BALL_PLANE } from '../models/vballnet';
import { defaultSettings } from '../settings';
import { BallStage } from './ball-stage';
import type { BallClip, PreparedFrame } from './inputs';

const US_PER_FRAME = 33_333;
const params: BallParams = defaultSettings(DEVICE_TIERS['wasm-mt']).ball;

/** A ball model that sees a ball only while `ballVisible` is set; counts its runs. */
function fakeModel() {
  const model = { runs: 0, ballVisible: false };
  const session = {
    async run() {
      model.runs++;
      const heatmaps = new Float32Array(2 * BALL_CLIP_LENGTH * BALL_PLANE);
      if (model.ballVisible) {
        for (let t = 0; t < BALL_CLIP_LENGTH; t++) {
          for (let i = 0; i < 25; i++) heatmaps[t * BALL_PLANE + 1000 + i] = 0.99;
        }
      }
      return { heatmaps: { data: heatmaps } };
    },
  } as unknown as InferenceSession;
  return { model, session };
}

const clip: BallClip = { tensor: () => ({}) as Tensor, padFrom: () => {} };
const frame: PreparedFrame = {
  detectorTensor: () => ({}) as Tensor,
  poseTensor: () => ({}) as Tensor,
  addToClip: () => {},
  close: () => {},
};

async function feed(stage: BallStage, frames: number, firstPtsUs = 0) {
  const out = [];
  for (let i = 0; i < frames; i++) out.push(...(await stage.add(frame, firstPtsUs + i * US_PER_FRAME, 1280, 720)));
  return out;
}

describe('BallStage.reset', () => {
  it('turns the model on again after the no-ball gate gave up on an earlier clip', async () => {
    const { model, session } = fakeModel();
    const stage = new BallStage(session, clip, params);
    await feed(stage, 108); // 3.6 s without a ball
    await stage.flush();
    expect(stage.active).toBe(false);
    const callsOfFirstClip = model.runs;
    expect(callsOfFirstClip).toBeGreaterThan(0);

    // Without a reset the gate persists: the next clip never reaches the model.
    expect(await feed(stage, 9)).toEqual([]);
    expect(model.runs).toBe(callsOfFirstClip);

    stage.reset();
    expect(stage.active).toBe(true);
    const results = await feed(stage, 9);
    expect(model.runs).toBe(callsOfFirstClip + 1);
    expect(results.map((r) => r.ptsUs)).toEqual(Array.from({ length: 9 }, (_, i) => i * US_PER_FRAME));
  });

  it('behaves like a fresh stage: same results, same gate timing, no pending frames carried over', async () => {
    const run = async (stage: BallStage, model: { ballVisible: boolean }) => {
      model.ballVisible = false;
      const a = await feed(stage, 99);
      model.ballVisible = true;
      const b = await feed(stage, 18, 99 * US_PER_FRAME);
      return { a, b, flushed: await stage.flush(), active: stage.active };
    };
    const fresh = fakeModel();
    const expected = await run(new BallStage(fresh.session, clip, params), fresh.model);

    const used = fakeModel();
    const stage = new BallStage(used.session, clip, params);
    await feed(stage, 4, 5_000_000); // a cancelled clip: four frames pending, none run
    used.model.ballVisible = false;
    await feed(stage, 108, 6_000_000);
    expect(stage.active).toBe(false);
    stage.reset();
    used.model.runs = 0;
    const actual = await run(stage, used.model);
    expect(actual).toEqual(expected);
    expect(used.model.runs).toBe(fresh.model.runs);
  });

  it('clears the frames still pending when a run was cancelled', async () => {
    const { model, session } = fakeModel();
    const stage = new BallStage(session, clip, params);
    await feed(stage, 5);
    stage.reset();
    expect(await stage.flush()).toEqual([]);
    expect(model.runs).toBe(0);
    const results = await feed(stage, 9, 7_000_000);
    expect(results).toHaveLength(9);
    expect(results[0]?.ptsUs).toBe(7_000_000);
  });
});
