import * as ort from 'onnxruntime-web/webgpu';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { findModel, MODEL_BASE, type ModelRole, modelUrl, ORT_ASSET_BASE, parseModelsLock } from '@/contracts/models';
import type { FramePipeline, MlRuntime, OrtApi, RawFrameResult } from '@/contracts/pipeline';
import lockJson from '../../../models.lock.json';
import { sessionOptions } from '../session-options';
import { defaultSettings } from '../settings';
import { createFramePipeline } from './frame-pipeline';

const FRAMES = ['att02_f0022', 'att02_f0066', 'att02_f0111', 'att02_f0155', 'att02_f0181', 'att02_f0200'];
const FRAME_STEP_US = 33_333;
/** A deadlocked pipeline never settles; fail well inside the test timeout instead of hanging. */
const DEADLOCK_MS = 60_000;

const tier = DEVICE_TIERS['webgpu-default'];
let runtime: MlRuntime;
let bitmaps: ImageBitmap[];

async function session(role: ModelRole, name: string) {
  const artifact = findModel(parseModelsLock(lockJson), name);
  const bytes = new Uint8Array(await (await fetch(modelUrl(artifact, MODEL_BASE))).arrayBuffer());
  return { artifact, session: await ort.InferenceSession.create(bytes, sessionOptions(role, 'webgpu')) };
}

/** Processes the frames with at most `inFlight` calls started and not yet settled, like the engine's frame loop. */
async function run(pipeline: FramePipeline, inFlight: number): Promise<RawFrameResult[]> {
  const results: Promise<RawFrameResult>[] = [];
  const pending = new Set<Promise<unknown>>();
  for (const [i, bitmap] of bitmaps.entries()) {
    const frame = new VideoFrame(bitmap, { timestamp: i * FRAME_STEP_US });
    const call = pipeline
      .process({
        ptsUs: i * FRAME_STEP_US,
        durationUs: FRAME_STEP_US,
        frameIndex: i,
        source: { kind: 'video-frame', frame },
        rotation: 0,
        displayWidth: bitmap.width,
        displayHeight: bitmap.height,
        runDetector: true,
        runBall: true,
      })
      .finally(() => frame.close());
    results.push(call);
    pending.add(call);
    call.then(
      () => pending.delete(call),
      () => pending.delete(call),
    );
    if (pending.size >= inFlight) await Promise.race(pending).catch(() => {});
  }
  return Promise.all(results);
}

async function runWithDeadline(inFlight: number) {
  const pipeline = await createFramePipeline(runtime, defaultSettings(tier));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${inFlight} frames in flight: process() never settled`)), DEADLOCK_MS);
  });
  try {
    const frames = await Promise.race([run(pipeline, inFlight), deadline]);
    const ball = [...frames.flatMap((f) => f.ballResults), ...(await pipeline.flush())];
    return { frames, ball };
  } finally {
    clearTimeout(timer);
    await pipeline.dispose();
  }
}

describe('FramePipeline with several frames in flight on real WebGPU', () => {
  beforeAll(async () => {
    ort.env.wasm.wasmPaths = ORT_ASSET_BASE;
    // ORT allows one WebGPU session to be created at a time.
    const detector = await session('person-detector', tier.models.detector);
    const pose = await session('pose', tier.models.pose);
    const ball = await session('ball', tier.models.ball);
    runtime = {
      ort: ort as unknown as OrtApi,
      backend: 'webgpu',
      device: (await ort.env.webgpu.device) as GPUDevice,
      sessions: { detector: detector.session, pose: pose.session, ball: ball.session },
      models: { detector: detector.artifact, pose: pose.artifact, ball: ball.artifact },
      tier,
    };
    bitmaps = await Promise.all(
      FRAMES.map(async (name) => createImageBitmap(await (await fetch(`/__fixtures/frames/${name}.png`)).blob())),
    );
  });
  afterAll(() => {
    for (const bitmap of bitmaps ?? []) bitmap.close();
  });

  it('settles every call and matches the one-at-a-time result with 2 and 3 calls in flight', async () => {
    const sequential = await runWithDeadline(1);
    expect(sequential.frames.some((f) => f.persons.length > 0)).toBe(true);
    for (const inFlight of [2, 3]) {
      const concurrent = await runWithDeadline(inFlight);
      expect(concurrent.frames.map((f) => f.ptsUs)).toEqual(sequential.frames.map((f) => f.ptsUs));
      expect(concurrent.frames.map((f) => f.persons.length)).toEqual(sequential.frames.map((f) => f.persons.length));
      expect(concurrent.ball.map((b) => b.ptsUs)).toEqual(sequential.ball.map((b) => b.ptsUs));
      expect(concurrent.ball.map((b) => b.candidates.length)).toEqual(sequential.ball.map((b) => b.candidates.length));
    }
  });
});
