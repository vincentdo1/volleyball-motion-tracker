import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineWarning } from '@/contracts/errors';
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

  it('ignores warnings that need no toast', () => {
    const engine = new MockEngine(DEFAULT_MOCK_CONFIG);
    const off = bridgeEngine(engine, actor);
    emitWarning(engine, { code: 'no-people-detected', message: 'No players were found.' });
    expect(toast).not.toHaveBeenCalled();
    expect(noticeFor({ code: 'resumed', message: 'x' })).toBeNull();
    off();
  });
});
