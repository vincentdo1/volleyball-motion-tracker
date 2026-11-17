/**
 * Accuracy of the Node reference pipeline on the 277 bake-off frames: onnxruntime-node CPU, fp32 models, the same
 * pre-processing and decoding code the browser runs. Writes bench-format predictions that the bake-off
 * `node/evaluate.mjs` scores against the teacher (see README.md).
 *   VBT_RUN_NAME=node-fp32 VBT_ML_RUNS_DIR=<dir> npm run test:harness -- src/ml/harness/static
 * Environment: VBT_FRAMES_DIR, VBT_BAKEOFF_DIR, VBT_ML_RUNS_DIR (see node-env.ts), VBT_RUN_NAME (default
 * `node-fp32`), VBT_DETECTOR / VBT_POSE (model ids), VBT_OKS_NMS (default TUNED_OKS_NMS; above 1 disables), VBT_LIMIT (first n frames, for quick checks).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { describe, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { HALPE26_NUM_KEYPOINTS, KP_VALUES } from '@/contracts/halpe26';
import type { MlRuntime } from '@/contracts/pipeline';
import { createFramePipeline } from '../pipeline/frame-pipeline';
import { sessionOptions } from '../session-options';
import { defaultSettings, TUNED_OKS_NMS } from '../settings';
import { cachedModel, RUNS_DIR, readFrame, readFrameMeta } from './node-env';

const RUN_NAME = process.env.VBT_RUN_NAME ?? 'node-fp32';
const DETECTOR = process.env.VBT_DETECTOR ?? 'dfine-s-coco.fp32';
const POSE = process.env.VBT_POSE ?? 'rtmpose-m-halpe26.fp32';
const OKS_NMS = Number(process.env.VBT_OKS_NMS ?? TUNED_OKS_NMS);
const LIMIT = Number(process.env.VBT_LIMIT ?? Number.POSITIVE_INFINITY);

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

describe('node reference pipeline', () => {
  it('writes predictions for the bake-off frames', async () => {
    const tier = DEVICE_TIERS['webgpu-default'];
    const detector = cachedModel(DETECTOR);
    const pose = cachedModel(POSE);
    const create = (model: { path: string }) =>
      ort.InferenceSession.create(model.path, sessionOptions('person-detector', 'node-cpu'));
    const runtime: MlRuntime = {
      ort,
      backend: 'node-cpu',
      device: null,
      sessions: { detector: await create(detector), pose: await create(pose), ball: null },
      models: { detector: detector.artifact, pose: pose.artifact, ball: null },
      tier,
    };
    const base = defaultSettings(tier);
    const pipeline = await createFramePipeline(runtime, { ...base, pose: { ...base.pose, oksNms: OKS_NMS } });

    const frames: Record<string, unknown> = {};
    const timings: number[] = [];
    for (const [index, meta] of readFrameMeta().slice(0, LIMIT).entries()) {
      const image = await readFrame(meta.file);
      const result = await pipeline.process({
        ptsUs: index * 1000,
        durationUs: 1000,
        frameIndex: index,
        source: { kind: 'pixels', ...image },
        rotation: 0,
        displayWidth: image.width,
        displayHeight: image.height,
        runDetector: true,
        runBall: false,
      });
      timings.push(result.timings.totalMs);
      frames[meta.file] = {
        W: image.width,
        H: image.height,
        persons: result.persons
          .filter((p) => p.origin === 'detector')
          .map((p) => ({
            box: p.box.map((v) => round(v, 1)),
            score: round(p.score, 3),
            kps: Array.from({ length: HALPE26_NUM_KEYPOINTS }, (_, k) =>
              [0, 1, 2].map((c) => round(p.keypoints[k * KP_VALUES + c] as number, c < 2 ? 1 : 3)),
            ),
          })),
      };
    }
    await pipeline.dispose();
    mkdirSync(RUNS_DIR, { recursive: true });
    const sorted = [...timings].sort((a, b) => a - b);
    writeFileSync(
      join(RUNS_DIR, `${RUN_NAME}.json`),
      JSON.stringify({
        name: RUN_NAME,
        detector: DETECTOR,
        pose: POSE,
        medianMs: sorted[Math.floor(sorted.length / 2)],
        frames,
      }),
    );
  });
});
