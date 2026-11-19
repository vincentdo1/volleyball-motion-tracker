/**
 * Person detections for the first frames of a test video, from the Node reference pipeline (onnxruntime-node CPU,
 * fp32 D-FINE-S + RTMPose-m, the app's thresholds). Frames come from ffmpeg in presentation order (the order WebCodecs
 * emits them) and are keyed by their PTS in microseconds.
 *   VBT_CLIP=<file in test_videos/> VBT_FRAMES=301 VBT_OUT=<json path> npm run test:harness -- src/ml/harness/clip-boxes
 * Output schema: see the README next to the handoff file (work/handoff/README.md).
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { describe, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { HALPE26_NUM_KEYPOINTS, KP_VALUES } from '@/contracts/halpe26';
import type { MlRuntime } from '@/contracts/pipeline';
import { createFramePipeline } from '../pipeline/frame-pipeline';
import { sessionOptions } from '../session-options';
import { defaultSettings } from '../settings';
import { cachedModel } from './node-env';

const CLIP = process.env.VBT_CLIP ?? 'github_gtu_20250316_002_volleyball_tracking.mp4';
const FRAMES = Number(process.env.VBT_FRAMES ?? 301);
const OUT = process.env.VBT_OUT;
const DETECTOR = process.env.VBT_DETECTOR ?? 'dfine-s-coco.fp32';
const POSE = process.env.VBT_POSE ?? 'rtmpose-m-halpe26.fp32';

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

interface StreamInfo {
  readonly width: number;
  readonly height: number;
  readonly timeBase: number;
}

function probe(path: string): { stream: StreamInfo; ptsTicks: number[] } {
  const run = (args: string[]) =>
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', ...args], { encoding: 'utf8' });
  const [width, height, tb] = run(['-show_entries', 'stream=width,height,time_base', '-of', 'csv=p=0', path])
    .trim()
    .split(',');
  const [num, den] = (tb as string).split('/').map(Number);
  const ptsTicks = run([
    '-show_entries',
    'frame=best_effort_timestamp',
    '-of',
    'csv=p=0',
    '-read_intervals',
    `%+#${FRAMES}`,
    path,
  ])
    .trim()
    .split('\n')
    .map((line) => Number(line.split(',')[0]));
  return {
    stream: { width: Number(width), height: Number(height), timeBase: (num as number) / (den as number) },
    ptsTicks,
  };
}

/** Raw RGB frames from ffmpeg, one Buffer per frame. */
async function* decodeFrames(path: string, frameBytes: number, count: number): AsyncGenerator<Buffer> {
  const ffmpeg = spawn(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let pending = Buffer.alloc(0);
  for await (const chunk of ffmpeg.stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= frameBytes) {
      yield pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
    }
  }
}

// A dump tool, not a check: it runs only when told where to write.
describe.skipIf(!OUT)('clip person boxes', () => {
  it('dumps the detections of the first frames', async () => {
    if (!OUT) throw new Error('set VBT_OUT to the output json path');
    const videoPath = resolve(process.cwd(), '..', 'test_videos', CLIP);
    const { stream, ptsTicks } = probe(videoPath);
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
    const settings = defaultSettings(tier);
    const pipeline = await createFramePipeline(runtime, settings);

    const frames: unknown[] = [];
    let index = 0;
    for await (const rgb of decodeFrames(videoPath, stream.width * stream.height * 3, ptsTicks.length)) {
      const ptsUs = Math.round((ptsTicks[index] as number) * stream.timeBase * 1e6);
      const result = await pipeline.process({
        ptsUs,
        durationUs: 0,
        frameIndex: index,
        source: { kind: 'pixels', data: rgb, width: stream.width, height: stream.height, channels: 3 },
        rotation: 0,
        displayWidth: stream.width,
        displayHeight: stream.height,
        runDetector: true,
        runBall: false,
      });
      frames.push({
        index,
        ptsUs,
        persons: result.persons.map((p) => ({
          box: p.box.map((v) => round(v, 1)),
          score: round(p.score, 3),
          origin: p.origin,
          keypoints:
            p.origin === 'detector'
              ? Array.from({ length: HALPE26_NUM_KEYPOINTS * KP_VALUES }, (_, i) =>
                  round(p.keypoints[i] as number, i % KP_VALUES < 2 ? 1 : 3),
                )
              : null,
        })),
      });
      index++;
    }
    await pipeline.dispose();
    mkdirSync(dirname(join(OUT)), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify({
        clip: CLIP,
        width: stream.width,
        height: stream.height,
        detector: DETECTOR,
        pose: POSE,
        thresholds: {
          personScore: settings.detector.scoreThreshold,
          lowScore: settings.detector.trackerLowScore,
          nmsIou: settings.detector.nmsIou,
          minBoxHeightPx: settings.detector.minBoxHeightPx,
          oksNms: settings.pose.oksNms,
        },
        frames,
      }),
    );
  });
});
