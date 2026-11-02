import type { DeviceTier, OrtFlavor } from '@/contracts/capabilities';
import type { ModelArtifact } from '@/contracts/models';
import type { MlRuntime } from '@/contracts/pipeline';
import type { ModelInfo } from '@/contracts/posetrack';
import { fail } from '../core/engine-exception';
import type { PreparedRuntime, RuntimeProvider, RuntimeRequest } from '../core/runtime-provider';
import { artifactById } from './model-lock';
import { ModelManager, type ModelManagerOptions } from './model-manager';
import { loadOrt } from './ort-loader';
import { QueueKick } from './queue-kick';
import { createSessions, releaseSessions } from './session-factory';

function artifactsOf(tier: DeviceTier): { detector: ModelArtifact; pose: ModelArtifact; ball: ModelArtifact } {
  return {
    detector: artifactById(tier.models.detector),
    pose: artifactById(tier.models.pose),
    ball: artifactById(tier.models.ball),
  };
}

function modelInfo(artifact: ModelArtifact, backend: ModelInfo['backend']): ModelInfo {
  const dims = artifact.io.inputs[0]?.dims ?? [];
  const [height, width] = dims.slice(-2);
  return {
    id: artifact.id,
    role: artifact.role,
    name: artifact.displayName,
    version: artifact.version,
    precision: artifact.precision,
    sha256: artifact.sha256,
    backend,
    inputSize: [typeof width === 'number' ? width : 0, typeof height === 'number' ? height : 0],
    license: artifact.license,
  };
}

/** Resolves with a reason when the device is lost for any reason other than an intentional destroy. */
function watchDevice(device: GPUDevice): Promise<string> {
  return new Promise((resolve) => {
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') resolve(`${info.reason}: ${info.message}`);
    });
    device.addEventListener('uncapturederror', (event) => {
      resolve(`uncaptured GPU error: ${(event as GPUUncapturedErrorEvent).error.message}`);
    });
  });
}

/** Production runtime: verified models from `/models/`, onnxruntime-web per flavour, sessions on ORT's device. */
export function createOrtRuntimeProvider(manager: ModelManagerOptions = {}): RuntimeProvider {
  return {
    async prepare(request: RuntimeRequest): Promise<PreparedRuntime> {
      const { tier, ml, capabilities, options } = request;
      const flavor: OrtFlavor = tier.backend === 'wasm' ? 'wasm' : (capabilities.ortFlavor ?? 'wasm');
      if (tier.backend === 'webgpu' && flavor === 'wasm') {
        throw fail('gpu-unavailable', 'This device has no usable WebGPU for the selected tier.');
      }
      const artifacts = artifactsOf(tier);
      const models = new ModelManager({
        ...manager,
        ...(options.modelBaseUrl === undefined ? {} : { baseUrl: options.modelBaseUrl }),
      });
      const [detector, pose, ball] = await Promise.all(
        [artifacts.detector, artifacts.pose, artifacts.ball].map(async (artifact) => ({
          artifact,
          bytes: await models.load(artifact, (progress) => request.onModelProgress(progress)),
        })),
      );
      if (!detector || !pose || !ball) throw fail('internal', 'Model loading returned no data.');
      const ort = await loadOrt({
        flavor,
        ...(options.ortBaseUrl === undefined ? {} : { baseUrl: options.ortBaseUrl }),
        crossOriginIsolated: capabilities.crossOriginIsolated,
        hardwareConcurrency: capabilities.hardwareConcurrency,
      });
      const sessions = await createSessions(ort, ml, tier.backend, { detector, pose, ball });
      const device = tier.backend === 'webgpu' ? await ort.env.webgpu.device : null;
      const kick = device && capabilities.browser.engine === 'gecko' ? new QueueKick(device) : null;
      const runtime: MlRuntime = {
        ort,
        backend: tier.backend,
        device,
        sessions,
        models: { detector: artifacts.detector, pose: artifacts.pose, ball: artifacts.ball },
        tier,
      };
      const infos = [artifacts.detector, artifacts.pose, artifacts.ball].map((a) => modelInfo(a, tier.backend));
      return {
        runtime,
        models: infos,
        modelKeys: infos.map((m) => `${m.id}:${m.sha256}`),
        deviceLost: device ? watchDevice(device) : new Promise<string>(() => undefined),
        setBusy: (busy) => (busy ? kick?.start() : kick?.stop()),
        dispose: async () => {
          kick?.stop();
          await releaseSessions(sessions);
        },
      };
    },
  };
}
