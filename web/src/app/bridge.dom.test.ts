import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineWarning } from '@/contracts/errors';
import type { ClipMetadata } from '@/contracts/posetrack';
import { syntheticFrameTable } from '@/render/synthetic';
import { toast } from '@/ui/toaster';
import { bridgeEngine } from './bridge';
import { DEFAULT_MOCK_CONFIG } from './mock/config';
import { MockEngine } from './mock/engine';
import { noticeFor } from './notices';
import { useSessionStore } from './stores/session';

vi.mock('@/ui/toaster', () => ({ toast: vi.fn() }));

const actor = { send: vi.fn() } as unknown as Parameters<typeof bridgeEngine>[1];

/** The backend's runtime-fallback warning; its code is not in the contract union yet. */
const FALLBACK = { code: 'tier-fallback', message: "failed to call OrtRun(): Shader 'Pad' parsing error" };

afterEach(() => {
  vi.clearAllMocks();
  useSessionStore.getState().clear();
  useSessionStore.getState().resetEngineWarnings();
});

function emitWarning(engine: MockEngine, warning: EngineWarning): void {
  (engine as unknown as { emit: (event: unknown) => void }).emit({ type: 'warning', warning });
}

describe('engine notices', () => {
  it('shows a calm toast, never the runtime text, when the engine falls back to the processor', () => {
    const engine = new MockEngine(DEFAULT_MOCK_CONFIG);
    const off = bridgeEngine(engine, actor);
    emitWarning(engine, FALLBACK as unknown as EngineWarning);
    expect(toast).toHaveBeenCalledTimes(1);
    const [title, options] = vi.mocked(toast).mock.calls[0] as [string, { description: string }];
    expect(title).toBe('Switched to a slower mode');
    expect(`${title} ${options.description}`).not.toMatch(/OrtRun|Shader|Pad/);
    off();
  });

  it('words the notice by the mode the engine moved to, and never promises identical results (M4-1)', () => {
    const toLite = { code: 'slow-mode', message: 'x', detail: { tier: 'webgpu-lite', reason: 'stalled' } } as const;
    const toCpu = {
      code: 'slow-mode',
      message: 'x',
      detail: { tier: 'wasm-mt', reason: 'gpu-inference-failed' },
    } as const;
    const lighter = noticeFor(toLite, true);
    expect(lighter?.title).toBe('Switched to a lighter mode');
    expect(lighter?.description).not.toMatch(/processor/);
    expect(lighter?.description).toMatch(/from the beginning/);
    const cpu = noticeFor(toCpu, true);
    expect(cpu?.title).toBe('Switched to a slower mode');
    expect(cpu?.description).toMatch(/processor/);
    expect(cpu?.description).toMatch(/from the beginning/);
    // at app start no clip is being analysed, so nothing starts again
    const atStart = noticeFor(toCpu);
    expect(atStart?.description).not.toMatch(/beginning|clip/);
    for (const notice of [lighter, cpu, atStart]) expect(notice?.description).not.toMatch(/the same/);
  });

  it('ignores warnings that need no toast', () => {
    const engine = new MockEngine(DEFAULT_MOCK_CONFIG);
    const off = bridgeEngine(engine, actor);
    emitWarning(engine, { code: 'no-people-detected', message: 'No players were found.' });
    expect(toast).not.toHaveBeenCalled();
    expect(noticeFor({ code: 'resumed', message: 'x' })).toBeNull();
    off();
  });
});

describe('engine-level notices (M3 #27)', () => {
  const SLOW = { code: 'tier-fallback', message: 'x' } as unknown as EngineWarning;
  const codes = () => useSessionStore.getState().warnings.map((w) => w.code);
  const open = (name: string) =>
    useSessionStore.getState().beginClip(name, {} as ClipMetadata, syntheticFrameTable(30, 8));
  const stateEvent = (engine: MockEngine, state: string) =>
    (engine as unknown as { emit: (e: unknown) => void }).emit({ type: 'state', state, previous: 'ready' });

  it('keeps a slow-mode warning from app start through beginClip and shows it with the clip notes', () => {
    const engine = new MockEngine(DEFAULT_MOCK_CONFIG);
    const off = bridgeEngine(engine, actor);
    emitWarning(engine, SLOW);
    expect(useSessionStore.getState().warnings).toHaveLength(0);
    open('a.mp4');
    expect(codes()).toEqual(['tier-fallback']);
    emitWarning(engine, { code: 'no-people-detected', message: 'No players were found.' });
    emitWarning(engine, { ...SLOW, message: 'worded again' });
    expect(codes()).toEqual(['tier-fallback', 'no-people-detected']);
    // it holds for the next clip too, but the clip's own notes do not
    useSessionStore.getState().clear();
    open('b.mp4');
    expect(codes()).toEqual(['tier-fallback']);
    off();
  });

  it('keeps a slow-mode warning that arrives while a clip is open for the clips after it', () => {
    const engine = new MockEngine(DEFAULT_MOCK_CONFIG);
    const off = bridgeEngine(engine, actor);
    open('a.mp4');
    emitWarning(engine, SLOW);
    expect(codes()).toEqual(['tier-fallback']);
    useSessionStore.getState().clear();
    open('b.mp4');
    expect(codes()).toEqual(['tier-fallback']);
    off();
  });

  it('survives a worker restart of the engine client (an initializing state event) during a clip', () => {
    const engine = new MockEngine(DEFAULT_MOCK_CONFIG);
    const off = bridgeEngine(engine, actor);
    open('a.mp4');
    emitWarning(engine, SLOW);
    stateEvent(engine, 'initializing');
    stateEvent(engine, 'ready');
    useSessionStore.getState().clear();
    open('b.mp4');
    expect(codes()).toEqual(['tier-fallback']);
    off();
  });

  it('is dropped when the app starts a new init attempt, and the toast does not say "this clip"', () => {
    const engine = new MockEngine(DEFAULT_MOCK_CONFIG);
    const off = bridgeEngine(engine, actor);
    emitWarning(engine, SLOW);
    useSessionStore.getState().resetEngineWarnings();
    open('a.mp4');
    expect(useSessionStore.getState().warnings).toHaveLength(0);
    expect(noticeFor(SLOW)?.description).not.toMatch(/this clip/i);
    off();
  });
});
