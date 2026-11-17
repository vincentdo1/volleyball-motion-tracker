import type { InferenceSession } from 'onnxruntime-common';
import type { ModelArtifact, ModelRole } from '@/contracts/models';
import type { MlBackend, MlModule, OrtApi } from '@/contracts/pipeline';
import { fail } from '../core/engine-exception';

export interface LoadedModel {
  readonly artifact: ModelArtifact;
  readonly bytes: Uint8Array;
}

export interface SessionSet {
  readonly detector: InferenceSession;
  readonly pose: InferenceSession;
  readonly ball: InferenceSession;
}

async function create(
  ort: OrtApi,
  ml: MlModule,
  backend: MlBackend,
  role: ModelRole,
  model: LoadedModel,
): Promise<InferenceSession> {
  try {
    return await ort.InferenceSession.create(model.bytes, ml.sessionOptions(role, backend));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (backend === 'webgpu' && /webgpu|adapter|gpu/i.test(message)) {
      throw fail('gpu-unavailable', 'The GPU could not be initialised for inference.', {
        modelId: model.artifact.id,
        reason: message,
      });
    }
    throw fail('model-load', `The model ${model.artifact.id} could not be loaded.`, {
      modelId: model.artifact.id,
      reason: message,
    });
  }
}

/**
 * Sessions from verified bytes with the ML module's options. Created in sequence: the first WebGPU session
 * creates ORT's device, which the later ones and `MlRuntime.device` share.
 */
export async function createSessions(
  ort: OrtApi,
  ml: MlModule,
  backend: MlBackend,
  models: { readonly detector: LoadedModel; readonly pose: LoadedModel; readonly ball: LoadedModel },
): Promise<SessionSet> {
  const detector = await create(ort, ml, backend, 'person-detector', models.detector);
  const pose = await create(ort, ml, backend, 'pose', models.pose);
  const ball = await create(ort, ml, backend, 'ball', models.ball);
  return { detector, pose, ball };
}

export async function releaseSessions(sessions: SessionSet): Promise<void> {
  await Promise.allSettled([sessions.detector.release(), sessions.pose.release(), sessions.ball.release()]);
}
