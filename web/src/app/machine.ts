import { assign, fromPromise, setup } from 'xstate';
import { type DeviceTierId, TIER_STEP_DOWN } from '@/contracts/capabilities';
import { type EngineError, engineError, isEngineError } from '@/contracts/errors';
import type { EngineApi, InitOptions, OpenedInfo, ResumeInfo } from '@/contracts/protocol';
import { ensureReady, openClip, startRun, stopRun } from './engine-lifecycle';
import { useSessionStore } from './stores/session';
import { useViewStore } from './stores/view';

/** A clip to analyse: a user file, or a sample fetched from a URL by the landing screen. */
export type ClipInput = File;

export interface AppInput {
  readonly engine: EngineApi;
  /** Opt-in to the heavier tier, read when the engine initialises. */
  readonly initOptions: () => InitOptions;
}

export interface AppContext {
  readonly engine: EngineApi;
  readonly initOptions: () => InitOptions;
  readonly file: ClipInput | null;
  /** Saved results of an earlier run of the same clip that this run can continue from. */
  readonly resume: ResumeInfo | null;
  /** Whether the analysis continues from the saved results (true) or starts over. */
  readonly continueRun: boolean;
  readonly error: EngineError | null;
  /** Where "Try again" goes back to. */
  readonly retry: 'boot' | 'open' | 'analyze';
  readonly tierOverride: DeviceTierId | null;
}

export type AppEvent =
  | { type: 'PICK'; file: ClipInput }
  | { type: 'ENGINE_DONE' }
  | { type: 'ENGINE_ERROR'; error: EngineError }
  | { type: 'CANCEL'; keep: boolean }
  | { type: 'CONTINUE' }
  | { type: 'START_OVER' }
  | { type: 'RETRY' }
  | { type: 'FALLBACK_TIER' }
  | { type: 'NEW_CLIP' }
  | { type: 'DISMISS' };

/** An earlier run is worth offering when it was made with the current settings. */
export function hasSavedRun({ resume }: Pick<OpenedInfo, 'resume'>): boolean {
  return resume !== null && resume.settingsMatch && resume.chunks > 0;
}

/** What the engine is initialised with, including a tier the user stepped down to. */
function engineOptions(context: AppContext): InitOptions {
  return { ...context.initOptions(), ...(context.tierOverride ? { tierOverride: context.tierOverride } : {}) };
}

function asEngineError(value: unknown): EngineError {
  if (isEngineError(value)) return value;
  return engineError('internal', value instanceof Error ? value.message : String(value));
}

/**
 * App flow (plan §3.4): booting -> landing -> probing -> analyzing -> results, plus `error` and `unsupported`.
 * The engine reports its own state; the machine only mirrors the outcomes it must react to (done, error).
 */
export const appMachine = setup({
  types: {
    context: {} as AppContext,
    events: {} as AppEvent,
    input: {} as AppInput,
  },
  actors: {
    boot: fromPromise(async ({ input }: { input: { engine: EngineApi; options: InitOptions } }) =>
      ensureReady(input.engine, input.options),
    ),
    open: fromPromise(async ({ input }: { input: { engine: EngineApi; file: ClipInput; options: InitOptions } }) => {
      const opened = await openClip(input.engine, input.file, input.options);
      useViewStore.getState().reset();
      useSessionStore.getState().beginClip(input.file, opened.clip, opened.frameTable);
      return opened;
    }),
    analyze: fromPromise(async ({ input }: { input: { engine: EngineApi; resume: boolean } }) =>
      startRun(input.engine, { resume: input.resume }),
    ),
  },
  actions: {
    fail: assign(({ event }) => ({ error: asEngineError((event as { error?: unknown }).error) })),
    clearError: assign({ error: null }),
    remember: assign(({ event }) => ({ file: event.type === 'PICK' ? event.file : null })),
    forget: () => {
      useSessionStore.getState().clear();
      useViewStore.getState().reset();
    },
    keepPartial: ({ context }) => {
      void stopRun(context.engine);
      useSessionStore.getState().endClip();
    },
    discard: ({ context }) => {
      void stopRun(context.engine);
    },
    continueRun: assign({ continueRun: true }),
    startOver: assign({ continueRun: false }),
    stepDownTier: assign(({ context }) => ({
      tierOverride: TIER_STEP_DOWN[context.tierOverride ?? 'webgpu-default'] ?? 'wasm-st',
    })),
  },
}).createMachine({
  id: 'app',
  initial: 'booting',
  context: ({ input }) => ({
    engine: input.engine,
    initOptions: input.initOptions,
    file: null,
    resume: null,
    continueRun: false,
    error: null,
    retry: 'boot',
    tierOverride: null,
  }),
  states: {
    booting: {
      invoke: {
        src: 'boot',
        input: ({ context }) => ({ engine: context.engine, options: engineOptions(context) }),
        onDone: [{ guard: ({ context }) => context.file !== null, target: 'probing' }, { target: 'landing' }],
        onError: [
          {
            guard: ({ event }) => asEngineError(event.error).code === 'unsupported-browser',
            target: 'unsupported',
            actions: 'fail',
          },
          { target: 'error', actions: ['fail', assign({ retry: 'boot' })] },
        ],
      },
      // a clip picked while the engine warms up starts as soon as it is ready
      on: { PICK: { actions: 'remember' } },
    },
    landing: {
      on: { PICK: { target: 'probing', actions: 'remember' } },
    },
    probing: {
      invoke: {
        src: 'open',
        input: ({ context }) => ({
          engine: context.engine,
          file: context.file as ClipInput,
          options: engineOptions(context),
        }),
        onDone: [
          {
            guard: ({ event }) => hasSavedRun(event.output),
            target: 'offering',
            actions: assign({ resume: ({ event }) => event.output.resume }),
          },
          { target: 'analyzing', actions: 'startOver' },
        ],
        onError: { target: 'error', actions: ['fail', assign({ retry: 'open' })] },
      },
    },
    // an earlier run of this clip was saved: continue it or start over
    offering: {
      on: {
        CONTINUE: { target: 'analyzing', actions: 'continueRun' },
        START_OVER: { target: 'analyzing', actions: 'startOver' },
        NEW_CLIP: { target: 'landing', actions: 'forget' },
      },
    },
    analyzing: {
      invoke: {
        src: 'analyze',
        input: ({ context }) => ({ engine: context.engine, resume: context.continueRun }),
        onError: { target: 'error', actions: ['fail', assign({ retry: 'analyze' })] },
      },
      on: {
        ENGINE_DONE: 'results',
        ENGINE_ERROR: { target: 'error', actions: ['fail', assign({ retry: 'analyze' })] },
        CANCEL: [
          { guard: ({ event }) => event.keep, target: 'results', actions: 'keepPartial' },
          { target: 'landing', actions: ['discard', 'forget'] },
        ],
      },
    },
    results: {
      on: { NEW_CLIP: { target: 'landing', actions: ['forget'] } },
    },
    error: {
      on: {
        RETRY: [
          { guard: ({ context }) => context.retry === 'boot', target: 'booting', actions: 'clearError' },
          { guard: ({ context }) => context.retry === 'open', target: 'probing', actions: 'clearError' },
          { target: 'analyzing', actions: 'clearError' },
        ],
        FALLBACK_TIER: { target: 'booting', actions: ['stepDownTier', 'clearError'] },
        NEW_CLIP: { target: 'landing', actions: ['clearError', 'forget'] },
        DISMISS: { target: 'landing', actions: ['clearError', 'forget'] },
      },
    },
    unsupported: { type: 'final' },
  },
});

export type AppMachine = typeof appMachine;
