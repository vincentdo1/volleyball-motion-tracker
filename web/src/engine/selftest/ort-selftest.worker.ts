import { ORT_ASSET_BASE } from '@/contracts/models';
import { failedSelfTest, type OrtSelfTestRequest, type OrtSelfTestResult } from './ort-selftest';

async function run(request: OrtSelfTestRequest): Promise<OrtSelfTestResult> {
  const ort =
    request.backend === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = ORT_ASSET_BASE;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, Math.max(1, navigator.hardwareConcurrency - 1)) : 1;
  ort.env.logLevel = 'error';
  const response = await fetch(request.modelUrl);
  if (!response.ok) return failedSelfTest(request, `model HTTP ${response.status} for ${request.modelUrl}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(bytes, { executionProviders: [request.backend] });
  const t1 = performance.now();
  const size = request.inputDims.reduce((a, b) => a * b, 1);
  const input = new ort.Tensor('float32', new Float32Array(size), [...request.inputDims]);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (inputName === undefined || outputName === undefined)
    return failedSelfTest(request, 'model has no inputs/outputs');
  const outputs = await session.run({ [inputName]: input });
  const t2 = performance.now();
  const output = outputs[outputName];
  const result: OrtSelfTestResult = {
    ok: output !== undefined,
    backend: request.backend,
    wasmPaths: String(ort.env.wasm.wasmPaths),
    crossOriginIsolated: self.crossOriginIsolated,
    numThreads: ort.env.wasm.numThreads ?? 0,
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames],
    outputDims: output ? [...output.dims] : [],
    createMs: Math.round(t1 - t0),
    runMs: Math.round(t2 - t1),
    error: null,
  };
  await session.release();
  return result;
}

self.onmessage = (event: MessageEvent<OrtSelfTestRequest>) => {
  run(event.data).then(
    (result) => self.postMessage(result),
    (error: unknown) =>
      self.postMessage(failedSelfTest(event.data, error instanceof Error ? error.message : String(error))),
  );
};
