import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineError } from '@/contracts/errors';
import type { ClipMetadata } from '@/contracts/posetrack';
import type { ExportRequest, ExportResult } from '@/contracts/protocol';
import { DEFAULT_RENDER_OPTIONS } from '@/contracts/renderer';
import type { EngineHandle } from '@/engine/client';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import { testScene } from '../testing';
import { ExportSheet } from './ExportSheet';

beforeEach(() => {
  const session = useSessionStore.getState();
  session.clear();
  session.beginClip('c.mp4', { frameCount: 24 } as ClipMetadata, testScene.frames);
  session.setFinal({ header: {} as never, frames: testScene.frames, tracks: testScene.tracks, ball: testScene.ball });
  useUiStore.getState().show('export');
});
afterEach(() => {
  cleanup();
  useUiStore.getState().close();
  useSessionStore.getState().clear();
});

/** An engine whose export runs until it is cancelled (or `finish` is called) like the real client's. */
function exportingEngine(onSignal?: (signal: AbortSignal | undefined) => void) {
  let reject: (error: unknown) => void = () => undefined;
  const exportResult = vi.fn(
    (_request: ExportRequest, options?: { readonly signal?: AbortSignal }) =>
      new Promise<ExportResult>((_resolve, rej) => {
        reject = rej;
        onSignal?.(options?.signal);
        options?.signal?.addEventListener('abort', () =>
          rej(engineError('export-failed', 'The export was cancelled.', { cancelled: true })),
        );
      }),
  );
  return {
    engine: { exportResult, on: () => () => undefined } as unknown as EngineHandle,
    exportResult,
    fail: (error: unknown) => reject(error),
  };
}

const mount = (engine: EngineHandle) =>
  render(<ExportSheet engine={engine} controller={null} options={DEFAULT_RENDER_OPTIONS} />);

describe('Export cancel (UI/UX 4)', () => {
  it('offers Cancel while a video export runs; it aborts the export without showing an error', async () => {
    let signal: AbortSignal | undefined;
    const { engine, exportResult } = exportingEngine((s) => {
      signal = s;
    });
    mount(engine);
    expect(screen.queryByTestId('export-cancel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export Video with skeletons' }));
    const cancel = await screen.findByTestId('export-cancel');
    expect(exportResult).toHaveBeenCalledWith(
      { kind: 'mp4', overlay: DEFAULT_RENDER_OPTIONS, includeAudio: true },
      expect.anything(),
    );
    expect(signal?.aborted).toBe(false);
    await act(async () => void fireEvent.click(cancel));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('export-cancel')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    // the controls are usable again
    expect((screen.getByRole('button', { name: 'Export Tracking data' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('still reports a real export failure', async () => {
    const { engine, fail } = exportingEngine();
    mount(engine);
    fireEvent.click(screen.getByRole('button', { name: 'Export Video with skeletons' }));
    await screen.findByTestId('export-cancel');
    await act(async () => fail(engineError('export-failed', 'The encoder stopped.')));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Export failed/);
  });
});
