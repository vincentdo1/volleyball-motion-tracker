/**
 * Engine worker with the stub ML module and runtime (no models, no ORT). Test knobs travel in the worker `name`
 * as JSON: `new Worker(url, { type: 'module', name: JSON.stringify(config) })`.
 */
import { startEngineWorker, type WorkerScope } from '../core/worker-runtime';
import { createOrtRuntimeProvider } from '../runtime/ort-provider';
import { createStubMl, type StubMlOptions } from './stub-ml';
import { createStubRuntimeProvider, type StubRuntimeOptions } from './stub-runtime';

export interface StubWorkerConfig {
  readonly ml?: StubMlOptions;
  readonly runtime?: StubRuntimeOptions;
  /** Use the real ORT runtime and model files with the stub ML module (model/ORT integration tests). */
  readonly realRuntime?: boolean;
  readonly timeoutFloorMs?: number;
}

function readConfig(): StubWorkerConfig {
  try {
    return self.name ? (JSON.parse(self.name) as StubWorkerConfig) : {};
  } catch {
    return {};
  }
}

const config = readConfig();
startEngineWorker(self as unknown as WorkerScope, {
  loadMl: async () => createStubMl(config.ml),
  runtime: config.realRuntime ? createOrtRuntimeProvider() : createStubRuntimeProvider(config.runtime),
  ...(config.timeoutFloorMs === undefined ? {} : { timeoutFloorMs: config.timeoutFloorMs }),
});
