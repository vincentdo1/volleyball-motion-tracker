import { createEngine, type EngineHandle } from '../client';
import type { StubWorkerConfig } from './stub-engine.worker';

/** An engine over the stub worker; `config` may depend on the worker generation (0 = first, then restarts). */
export function createStubEngine(
  config: StubWorkerConfig | ((generation: number) => StubWorkerConfig) = {},
): EngineHandle {
  return createEngine({
    createWorker: (generation) =>
      new Worker(new URL('./stub-engine.worker.ts', import.meta.url), {
        type: 'module',
        name: JSON.stringify(typeof config === 'function' ? config(generation) : config),
      }),
  });
}

/** Fetches a dev-server fixture clip as a `File`. */
export async function fixtureFile(name: string): Promise<File> {
  const response = await fetch(`/__fixtures/videos/${name}`);
  if (!response.ok) throw new Error(`fixture ${name}: HTTP ${response.status}`);
  return new File([await response.blob()], name, { type: 'video/mp4', lastModified: 1_700_000_000_000 });
}
