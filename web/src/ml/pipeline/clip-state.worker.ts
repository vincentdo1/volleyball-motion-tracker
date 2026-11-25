/**
 * Test-only engine worker: the real engine core and the real ML module over fake ORT sessions (see
 * `clip-state.browser.test.ts`). The detector sees nobody; the ball model sees a ball at one fixed spot while the page
 * has said so, and reports its run count. The page talks to it over the BroadcastChannel `CHANNEL`.
 */
import type { InferenceSession, Tensor } from 'onnxruntime-common';
import type { MlRuntime, OrtApi } from '@/contracts/pipeline';
import type { RuntimeProvider } from '../../engine/core/runtime-provider';
import { startEngineWorker, type WorkerScope } from '../../engine/core/worker-runtime';
import { mlModule } from '../index';
import { BALL_CLIP_LENGTH, BALL_INPUT_WIDTH, BALL_PLANE } from '../models/vballnet';

export const CHANNEL = 'clip-state-test';
export type PageToWorker = { readonly ballVisible: boolean };
export type WorkerToPage = { readonly ballRuns: number };

const channel = new BroadcastChannel(CHANNEL);
let ballVisible = false;
let ballRuns = 0;
/** Ball frames seen since the page last said a clip starts: the ball moves with it, so a clip always looks the same. */
let ballFrame = 0;
channel.onmessage = (message: MessageEvent<PageToWorker>) => {
  ballVisible = message.data.ballVisible;
  ballFrame = 0;
};

const detector = {
  async run() {
    return {
      logits: { data: new Float32Array(300 * 80).fill(-20) },
      pred_boxes: { data: new Float32Array(300 * 4) },
    };
  },
};
const pose = {
  async run() {
    return {};
  },
};
const ball = {
  async run() {
    ballRuns++;
    channel.postMessage({ ballRuns } satisfies WorkerToPage);
    const heatmaps = new Float32Array(2 * BALL_CLIP_LENGTH * BALL_PLANE);
    if (ballVisible) {
      for (let t = 0; t < BALL_CLIP_LENGTH; t++, ballFrame++) {
        const cx = 30 + ((ballFrame * 3) % 440);
        const cy = Math.round(120 + 60 * Math.sin(ballFrame / 12));
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const at = (cy + dy) * BALL_INPUT_WIDTH + cx + dx;
            heatmaps[t * BALL_PLANE + at] = 0.99;
            heatmaps[(BALL_CLIP_LENGTH + t) * BALL_PLANE + at] = 0.01;
          }
        }
      }
    }
    return { heatmaps: { data: heatmaps } };
  },
};

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: unknown,
    readonly dims: readonly number[],
  ) {}
}

const ROLES = ['person-detector', 'pose', 'ball'] as const;

const provider: RuntimeProvider = {
  async prepare(request) {
    const infos = Object.values(request.tier.models).map((id, i) => ({
      id,
      role: ROLES[i] as 'pose',
      name: id,
      version: 'fake',
      precision: 'fp32' as const,
      sha256: '0'.repeat(64),
      backend: request.tier.backend,
      inputSize: [1, 1] as [number, number],
      license: 'Apache-2.0',
    }));
    const runtime = {
      ort: { Tensor: FakeTensor as unknown as typeof Tensor } as unknown as OrtApi,
      backend: 'wasm',
      device: null,
      sessions: {
        detector: detector as unknown as InferenceSession,
        pose: pose as unknown as InferenceSession,
        ball: ball as unknown as InferenceSession,
      },
      models: {} as MlRuntime['models'],
      tier: request.tier,
    } satisfies MlRuntime;
    return {
      runtime,
      models: infos,
      modelKeys: infos.map((m) => `${m.id}:${m.sha256}`),
      deviceLost: new Promise<string>(() => {}),
      setBusy: () => {},
      dispose: async () => {},
    };
  },
};

startEngineWorker(self as unknown as WorkerScope, { loadMl: async () => mlModule, runtime: provider });
