/** Production engine worker: real ORT runtime and models, ML module from `ml-loader.ts`. */
import { startEngineWorker, type WorkerScope } from './core/worker-runtime';
import { loadMlModule } from './ml-loader';
import { createOrtRuntimeProvider } from './runtime/ort-provider';

startEngineWorker(self as unknown as WorkerScope, {
  loadMl: loadMlModule,
  runtime: createOrtRuntimeProvider(),
});
