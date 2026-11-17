// biome-ignore-all lint/suspicious/noExplicitAny: diagnostic repro page for M2-1, not shipped code
/** Diagnostic page: real ML pipeline on frames decoded by mediabunny (like the engine), on the main thread. */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { findModel, MODEL_BASE, modelUrl, ORT_ASSET_BASE, parseModelsLock } from '@/contracts/models';
import lockJson from '../../models.lock.json';
import { createFramePipeline } from '../../src/ml/pipeline/frame-pipeline';
import { sessionOptions } from '../../src/ml/session-options';
import { defaultSettings } from '../../src/ml/settings';

const inWorker = typeof document === 'undefined';
const q = new URLSearchParams(inWorker ? (self as any).name : location.search);
const out = (inWorker ? {} : window) as unknown as { __probe: unknown };
const status = (inWorker ? { textContent: '' } : document.getElementById('status')) as HTMLElement;
const log: string[] = [];
const say = (s: string) => {
  log.push(`${Math.round(performance.now())} ${s}`);
  status.textContent = log.join('\n');
  if (inWorker) postMessage({ say: s });
};
async function main() {
  const lock = parseModelsLock(lockJson);
  const tier = DEVICE_TIERS['webgpu-default'];
  const ort = (await import('onnxruntime-web/webgpu')) as any;
  ort.env.wasm.wasmPaths = ORT_ASSET_BASE;
  const mk = async (id: string) => {
    const a = findModel(lock, id);
    return {
      a,
      s: await ort.InferenceSession.create(
        new Uint8Array(await (await fetch(modelUrl(a, MODEL_BASE))).arrayBuffer()),
        sessionOptions(a.role, 'webgpu'),
      ),
    };
  };
  const d = await mk(tier.models.detector),
    p = await mk(tier.models.pose),
    b = await mk(tier.models.ball);
  const device = await ort.env.webgpu.device;
  const runtime: any = {
    ort,
    backend: 'webgpu',
    device,
    sessions: { detector: d.s, pose: p.s, ball: b.s },
    models: { detector: d.a, pose: p.a, ball: b.a },
    tier,
  };
  const pipe = await createFramePipeline(runtime, defaultSettings(tier));
  say('pipeline ready');
  const blob = await (await fetch(`/__fixtures/videos/${q.get('clip') ?? 'volleyball_spike_attempt_03.mp4'}`)).blob();
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sink = new VideoSampleSink(track!);
  let n = 0;
  const inflight: Promise<void>[] = [];
  const conc = Number(q.get('conc') ?? 1);
  const ball = q.get('ball') === '1';
  for await (const sample of sink.samples()) {
    if (sample.timestamp < 0) {
      sample.close();
      continue;
    }
    const frame = sample.toVideoFrame();
    const i = n;
    const t0 = performance.now();
    const pr = pipe
      .process({
        ptsUs: Math.round(sample.timestamp * 1e6),
        durationUs: 33333,
        frameIndex: i,
        source: { kind: 'video-frame', frame },
        rotation: 0,
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
        runDetector: true,
        runBall: ball,
      })
      .then((r) => {
        say(`frame ${i} persons=${r.persons.length} ${Math.round(performance.now() - t0)} ms wall`);
        frame.close();
        sample.close();
      });
    inflight.push(pr);
    say(`frame ${i} submitted`);
    if (inflight.length >= conc)
      await Promise.race([
        inflight[0],
        new Promise((r) => setTimeout(r, 8000)).then(() => say('STALL waiting for frame')),
      ]);
    if (inflight.length >= conc) inflight.shift();
    if (++n >= Number(q.get('n') ?? 3)) break;
  }
  await Promise.all(inflight);
  if (inWorker) postMessage({ done: true });
  else (out as any).__probe = { done: true, log };
}

if (!inWorker && q.get('worker')) {
  const w = new Worker(new URL('./m2-probe.ts', import.meta.url), { type: 'module', name: location.search });
  w.onmessage = (e) => {
    if (e.data.say) say('W: ' + e.data.say);
    if (e.data.done) (out as any).__probe = { done: true, log };
  };
  w.onerror = (e) => say('W error ' + e.message);
} else {
  main().catch((e) => {
    say('ERR ' + e);
    (out as any).__probe = { done: true, error: String(e), log };
  });
}
