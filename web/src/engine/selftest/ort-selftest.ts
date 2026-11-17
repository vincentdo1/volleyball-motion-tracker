/** M0 toolchain check: create an onnxruntime-web session inside a module worker and run one inference. */
export interface OrtSelfTestRequest {
  readonly modelUrl: string;
  readonly backend: 'webgpu' | 'wasm';
  /** Input shape for a zero-filled float32 tensor. */
  readonly inputDims: readonly number[];
}

export interface OrtSelfTestResult {
  readonly ok: boolean;
  readonly backend: 'webgpu' | 'wasm';
  readonly wasmPaths: string;
  readonly crossOriginIsolated: boolean;
  readonly numThreads: number;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly outputDims: readonly number[];
  readonly createMs: number;
  readonly runMs: number;
  readonly error: string | null;
}

export function failedSelfTest(request: OrtSelfTestRequest, error: string): OrtSelfTestResult {
  return {
    ok: false,
    backend: request.backend,
    wasmPaths: '',
    crossOriginIsolated: false,
    numThreads: 0,
    inputNames: [],
    outputNames: [],
    outputDims: [],
    createMs: 0,
    runMs: 0,
    error,
  };
}

export function runOrtSelfTest(request: OrtSelfTestRequest, timeoutMs = 90_000): Promise<OrtSelfTestResult> {
  const worker = new Worker(new URL('./ort-selftest.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ort-selftest',
  });
  return new Promise((resolve) => {
    const finish = (result: OrtSelfTestResult) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(failedSelfTest(request, `timed out after ${timeoutMs} ms`)), timeoutMs);
    worker.onmessage = (event: MessageEvent<OrtSelfTestResult>) => finish(event.data);
    worker.onerror = (event) => finish(failedSelfTest(request, event.message || 'worker failed to load'));
    worker.postMessage(request);
  });
}
