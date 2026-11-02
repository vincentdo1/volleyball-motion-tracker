import type { MlModule } from '@/contracts/pipeline';

/** Loads the ML module (`web/src/ml/`) for the engine worker; the dynamic import keeps it out of the worker's first chunk. */
export async function loadMlModule(): Promise<MlModule> {
  const { mlModule } = await import('@/ml');
  return mlModule;
}
