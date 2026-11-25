import type { InferenceSession } from 'onnxruntime-common';
import type { MlRuntime, OrtApi } from '@/contracts/pipeline';
import type { ModelInfo } from '@/contracts/posetrack';
import type { PreparedRuntime, RuntimeProvider, RuntimeRequest } from '../core/runtime-provider';

/** A runtime without ORT or model files: the stub ML module never touches its sessions. */
export interface StubRuntimeOptions {
  /** Resolves `deviceLost` after this many ms of being busy (simulated GPU reset). */
  readonly loseDeviceAfterMs?: number;
  /** Called with 'prepared' for every runtime set loaded and 'disposed' for every one released (in-page cores only). */
  readonly onLifecycle?: (event: 'prepared' | 'disposed') => void;
}

const session = {} as InferenceSession;

/** A well-formed (64 hex digits) digest that differs per model id. */
function sha256Of(id: string): string {
  return Array.from(id, (c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64);
}

function modelInfo(request: RuntimeRequest, role: ModelInfo['role'], id: string): ModelInfo {
  return {
    id,
    role,
    name: `stub ${id}`,
    version: 'stub',
    precision: 'fp32',
    sha256: sha256Of(id),
    backend: request.tier.backend,
    inputSize: [request.tier.detectorInputSize, request.tier.detectorInputSize],
    license: 'Apache-2.0',
  };
}

export function createStubRuntimeProvider(options: StubRuntimeOptions = {}): RuntimeProvider {
  return {
    async prepare(request): Promise<PreparedRuntime> {
      const { models } = request.tier;
      const infos = [
        modelInfo(request, 'person-detector', models.detector),
        modelInfo(request, 'pose', models.pose),
        modelInfo(request, 'ball', models.ball),
      ];
      for (const info of infos) {
        request.onModelProgress({ modelId: info.id, bytesDone: 1, bytesTotal: 1, fromCache: true });
      }
      const runtime = {
        ort: {} as OrtApi,
        backend: request.tier.backend,
        device: null,
        sessions: { detector: session, pose: session, ball: session },
        models: {} as MlRuntime['models'],
        tier: request.tier,
      } satisfies MlRuntime;
      let lose: (reason: string) => void = () => undefined;
      const deviceLost = new Promise<string>((resolve) => {
        lose = resolve;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      options.onLifecycle?.('prepared');
      return {
        runtime,
        models: infos,
        modelKeys: infos.map((m) => `${m.id}:${m.sha256}`),
        deviceLost,
        setBusy(busy) {
          if (busy && options.loseDeviceAfterMs !== undefined && timer === undefined) {
            timer = setTimeout(() => lose('stub: device lost'), options.loseDeviceAfterMs);
          }
        },
        dispose: async () => {
          clearTimeout(timer);
          options.onLifecycle?.('disposed');
        },
      };
    },
  };
}
