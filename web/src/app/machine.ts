import { assign, fromPromise, setup } from 'xstate';
import { type DeviceTierId, TIER_STEP_DOWN } from '@/contracts/capabilities';
import { type EngineError, engineError, isEngineError } from '@/contracts/errors';
import type { EngineApi, InitOptions } from '@/contracts/protocol';
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
  | { type: 'RETRY' }
  | { type: 'FALLBACK_TIER' }
  | { type: 'NEW_CLIP' }
  | { type: 'DISMISS' };

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
      input.engine.init(input.options),
    ),
    open: fromPromise(async ({ input }: { input: { engine: EngineApi; file: ClipInput } }) => {
      const opened = await input.engine.open(input.file);
      useViewStore.getState().reset();
      useSessionStore.getState().beginClip(input.file, opened.clip, opened.frameTable);
      return opened;
    }),
    analyze: fromPromise(async ({ input }: { input: { engine: EngineApi } }) => input.engine.start()),
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
      void context.engine.cancel();
      useSessionStore.getState().endClip();
    },
    discard: ({ context }) => {
      void context.engine.cancel();
    },
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
    error: null,
    retry: 'boot',
    tierOverride: null,
  }),
  states: {
    booting: {
      invoke: {
        src: 'boot',
        input: ({ context }) => ({
          engine: context.engine,
          options: {
            ...context.initOptions(),
            ...(context.tierOverride ? { tierOverride: context.tierOverride } : {}),
          },
        }),
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
        input: ({ context }) => ({ engine: context.engine, file: context.file as ClipInput }),
        onDone: 'analyzing',
        onError: { target: 'error', actions: ['fail', assign({ retry: 'open' })] },
      },
    },
    analyzing: {
      invoke: {
        src: 'analyze',
        input: ({ context }) => ({ engine: context.engine }),
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
