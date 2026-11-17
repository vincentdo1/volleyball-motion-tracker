/**
 * Dev-only browser bench for the frame pipeline: runs the real `FramePipeline` (WebGPU with GPU pre-processing, or
 * WASM) over the bake-off frames served at `/__fixtures/frames/` and publishes bench-format predictions plus
 * per-stage timings as `window.__bench`. Driven by `scripts/ml/run-bench.mjs`.
 * Query: tier (default webgpu-default), set = static | run | all (default static), limit, cadence (detector every n-th
 * frame of a run), detector / pose (model ids overriding the tier's), name.
 */
import { DEVICE_TIERS, type DeviceTierId } from '@/contracts/capabilities';
import { HALPE26_NUM_KEYPOINTS, KP_VALUES } from '@/contracts/halpe26';
import { findModel, MODEL_BASE, modelUrl, ORT_ASSET_BASE, parseModelsLock } from '@/contracts/models';
import type { BallFrameCandidates, MlBackend, MlRuntime, OrtApi, StageTimings } from '@/contracts/pipeline';
import lockJson from '../../../models.lock.json';
import { createFramePipeline } from '../pipeline/frame-pipeline';
import { sessionOptions } from '../session-options';
import { defaultSettings } from '../settings';

interface FrameMeta {
  file: string;
  clip: string;
  index: number;
  kinds: string[];
  pts_ms: number;
  W: number;
  H: number;
}

const query = new URLSearchParams(location.search);
const status = document.getElementById('status') as HTMLElement;
const log = (text: string) => {
  status.textContent = text;
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

async function loadOrt(backend: MlBackend): Promise<OrtApi> {
  const ort = (await (backend === 'webgpu'
    ? import('onnxruntime-web/webgpu')
    : import('onnxruntime-web/wasm'))) as unknown as OrtApi & {
    env: { wasm: { wasmPaths: string; numThreads: number } };
  };
  ort.env.wasm.wasmPaths = ORT_ASSET_BASE;
  ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency) : 1;
  return ort;
}

async function run() {
  const lock = parseModelsLock(lockJson);
  const tier = DEVICE_TIERS[(query.get('tier') ?? 'webgpu-default') as DeviceTierId];
  const detector = findModel(lock, query.get('detector') ?? tier.models.detector);
  const pose = findModel(lock, query.get('pose') ?? tier.models.pose);
  const ball = findModel(lock, tier.models.ball);
  const backend: MlBackend = tier.backend;
  const set = query.get('set') ?? 'static';
  const limit = Number(query.get('limit') ?? Number.POSITIVE_INFINITY);
  const base = defaultSettings(tier);
  const cadence = Number(query.get('cadence') ?? 1);
  const settings = { ...base, detector: { ...base.detector, cadence } };

  log('loading ORT and models');
  const ort = await loadOrt(backend);
  const create = async (artifact: typeof detector) =>
    ort.InferenceSession.create(
      new Uint8Array(await (await fetch(modelUrl(artifact, MODEL_BASE))).arrayBuffer()),
      sessionOptions(artifact.role, backend),
    );
  const sessions = { detector: await create(detector), pose: await create(pose), ball: await create(ball) };
  const gpuDevice =
    backend === 'webgpu'
      ? ((await (ort.env as { webgpu: { device: Promise<GPUDevice> } }).webgpu.device) ?? null)
      : null;
  const runtime: MlRuntime = {
    ort,
    backend,
    device: gpuDevice,
    sessions,
    models: { detector, pose, ball },
    tier,
  };
  const pipeline = await createFramePipeline(runtime, settings);
  log('warming up');
  const warmup: StageTimings = await pipeline.warmup();

  const meta = (await (await fetch('/__fixtures/bakeoff/frames_meta.json')).json()) as { frames: FrameMeta[] };
  const frames = meta.frames
    .filter((f) => set === 'all' || (set === 'static' ? f.kinds.some((k) => k !== 'run') : f.kinds.includes('run')))
    .slice(0, limit);

  const predictions: Record<string, unknown> = {};
  const totals: number[] = [];
  const stages: Record<keyof StageTimings, number[]> = {
    preMs: [],
    detectorMs: [],
    poseMs: [],
    ballMs: [],
    postMs: [],
    totalMs: [],
  };
  const ballResults: BallFrameCandidates[] = [];
  const clipStart = new Map<string, number>();
  for (const [n, f] of frames.entries()) {
    log(`frame ${n + 1}/${frames.length} ${f.file}`);
    const bitmap = await createImageBitmap(await (await fetch(`/__fixtures/frames/${f.file}`)).blob());
    const frame = new VideoFrame(bitmap, { timestamp: Math.round(f.pts_ms * 1000) });
    bitmap.close();
    const firstOfClip = clipStart.get(f.clip) ?? f.index;
    clipStart.set(f.clip, firstOfClip);
    const result = await pipeline.process({
      ptsUs: Math.round(f.pts_ms * 1000),
      durationUs: 33_333,
      frameIndex: f.index,
      source: { kind: 'video-frame', frame },
      rotation: 0,
      displayWidth: f.W,
      displayHeight: f.H,
      runDetector: set === 'static' || (f.index - firstOfClip) % cadence === 0,
      runBall: set !== 'static',
    });
    frame.close();
    for (const key of Object.keys(stages) as (keyof StageTimings)[]) stages[key].push(result.timings[key]);
    totals.push(result.timings.totalMs);
    ballResults.push(...result.ballResults);
    predictions[f.file] = {
      W: f.W,
      H: f.H,
      persons: result.persons
        .filter((p) => p.origin !== 'detector-low')
        .map((p) => ({
          box: p.box.map((v) => round(v, 1)),
          score: round(p.score, 3),
          kps: Array.from({ length: HALPE26_NUM_KEYPOINTS }, (_, k) =>
            [0, 1, 2].map((c) => round(p.keypoints[k * KP_VALUES + c] as number, c < 2 ? 1 : 3)),
          ),
        })),
    };
  }
  ballResults.push(...(await pipeline.flush()));
  await pipeline.dispose();

  return {
    name: query.get('name') ?? `${tier.id}-${set}`,
    tier: tier.id,
    backend,
    models: { detector: detector.id, pose: pose.id, ball: ball.id },
    set,
    cadence,
    warmup,
    medianMs: median(totals),
    stageMedianMs: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, round(median(v), 2)])),
    frames: predictions,
    ball: ballResults,
  };
}

const bench = window as unknown as { __bench: { done: boolean; result?: unknown; error?: string } };
bench.__bench = { done: false };
run().then(
  (result) => {
    bench.__bench = { done: true, result };
    log('done');
  },
  (error: unknown) => {
    bench.__bench = { done: true, error: String(error instanceof Error ? `${error.message}\n${error.stack}` : error) };
    log(`failed: ${String(error)}`);
  },
);
