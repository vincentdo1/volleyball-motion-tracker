/**
 * Dev harness for Playwright: `window.__engineHarness` drives the engine without any UI. `useStub: true` runs the
 * stub ML module (the production worker needs the linked ML module); fixtures come from the dev server.
 */
import type { FinalResult } from '@/contracts/posetrack';
import type { EngineEvent, InitOptions, ReadyInfo, StartOptions } from '@/contracts/protocol';
import { createEngine, type EngineHandle } from '../client';
import { createStubEngine, fixtureFile } from '../testing/stub-engine';

export interface HarnessRunOptions {
  readonly useStub?: boolean;
  readonly init?: InitOptions;
  readonly start?: StartOptions;
}

export interface HarnessRun {
  readonly ready: ReadyInfo;
  readonly result: FinalResult;
  readonly events: readonly EngineEvent[];
}

const EVENT_TYPES = [
  'state',
  'ready',
  'opened',
  'model-progress',
  'progress',
  'chunk',
  'final',
  'export-progress',
  'export-done',
  'warning',
  'error',
  'stats',
] as const satisfies readonly EngineEvent['type'][];

export interface EngineHarness {
  /** The engine of the latest `run`, kept for follow-up calls (`exportResult`, `cancel`, ...). */
  engine: EngineHandle | null;
  /** Every event of the latest run, in arrival order. */
  events: EngineEvent[];
  fixture(name: string): Promise<File>;
  /** Initialises a fresh engine, opens the fixture clip, processes it and resolves with the final result. */
  run(clip: string, options?: HarnessRunOptions): Promise<HarnessRun>;
  dispose(): Promise<void>;
}

function waitForSettled(engine: EngineHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopState = engine.on('state', (e) => {
      if (e.state !== 'done') return;
      stopState();
      stopError();
      resolve();
    });
    const stopError = engine.on('error', (e) => {
      stopState();
      stopError();
      reject(new Error(`${e.error.code}: ${e.error.message}`));
    });
  });
}

const harness: EngineHarness = {
  engine: null,
  events: [],
  fixture: fixtureFile,
  async run(clip, options = {}) {
    await harness.dispose();
    const engine = options.useStub ? createStubEngine() : createEngine();
    harness.engine = engine;
    for (const type of EVENT_TYPES) engine.on(type, (event) => harness.events.push(event));
    const ready = await engine.init(options.init);
    await engine.open(await fixtureFile(clip));
    const settled = waitForSettled(engine);
    await engine.start(options.start);
    await settled;
    const final = harness.events.find((e) => e.type === 'final');
    if (final?.type !== 'final') throw new Error('The run finished without a final result.');
    return { ready, result: final.result, events: harness.events };
  },
  async dispose() {
    await harness.engine?.dispose();
    harness.engine = null;
    harness.events = [];
  },
};

declare global {
  interface Window {
    __engineHarness: EngineHarness;
  }
}
window.__engineHarness = harness;
