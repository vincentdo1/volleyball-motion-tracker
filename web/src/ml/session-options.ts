import type { InferenceSession } from 'onnxruntime-common';
import type { ModelRole } from '@/contracts/models';
import type { MlBackend } from '@/contracts/pipeline';

const EXECUTION_PROVIDER: Record<MlBackend, string> = { webgpu: 'webgpu', wasm: 'wasm', 'node-cpu': 'cpu' };

/**
 * Options the engine passes to `InferenceSession.create`. Every role uses the same ones today (full graph
 * optimisation, CPU-side outputs, error-level logging so ORT's expected "nodes assigned to the CPU" warning on the
 * WebGPU provider stays quiet); the role parameter is part of the module contract.
 */
export function sessionOptions(_role: ModelRole, backend: MlBackend): InferenceSession.SessionOptions {
  return {
    executionProviders: [EXECUTION_PROVIDER[backend]],
    graphOptimizationLevel: 'all',
    logSeverityLevel: 3,
  };
}
