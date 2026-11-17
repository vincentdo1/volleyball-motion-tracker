import type { MlModule } from '@/contracts/pipeline';

/**
 * Loads the ML module (`web/src/ml/`) for the engine worker. The dynamic import only delays evaluating the module
 * until `init`. It does not keep the code that the engine and the ML module share out of the engine chunk: the
 * bundler hoists that code into `engine.worker`, which the ML chunk (and the ORT chunks) then import by URL. That is
 * safe only because the worker's entry is `app/engine-worker.ts`, a tiny module that nothing imports and that
 * evaluates once; a chunk that imports the entry itself makes WebKit evaluate it again (see `core/worker-runtime.ts`).
 */
export async function loadMlModule(): Promise<MlModule> {
  const { mlModule } = await import('@/ml');
  return mlModule;
}
