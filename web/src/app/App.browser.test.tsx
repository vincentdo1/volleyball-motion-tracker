import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { saveBlob } from './export/download';
import { isPartialResult, useSessionStore } from './stores/session';
import { useSettingsStore } from './stores/settings';
import { useUiStore } from './stores/ui';
import { useViewStore } from './stores/view';

vi.mock('./export/download', () => ({ saveBlob: vi.fn() }));

const CLIP = '/__fixtures/videos/volleyball_spike_attempt_03.mp4';
const SLOW = { timeout: 30_000 };

async function chooseClip(): Promise<void> {
  const blob = await (await fetch(CLIP)).blob();
  const file = new File([blob], 'volleyball_spike_attempt_03.mp4', { type: 'video/mp4' });
  fireEvent.change(await screen.findByTestId('file-input'), { target: { files: [file] } });
}

function start(search: string): void {
  window.history.replaceState(null, '', `/${search}`);
  render(<App />);
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ dismissedHints: [] });
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clear();
  useViewStore.getState().reset();
  useUiStore.getState().close();
  window.history.replaceState(null, '', '/');
});

describe('first visit: preparing the analysis (UI/UX 1)', () => {
  it('shows Preparing analysis with the download progress from the choice of a file until the analysis starts', async () => {
    start('?mock=1,download');
    await chooseClip();
    // at once, in the landing screen: never an idle drop zone after the choice
    const status = await screen.findByTestId('preparing');
    expect(status.textContent).toMatch(/Preparing analysis/);
    expect(screen.queryByText('Drop a volleyball clip here')).toBeNull();
    const progress = await screen.findByTestId('preparing-progress', undefined, SLOW);
    expect(progress.textContent).toMatch(/^\d+% \(/);
    expect(screen.getByRole('progressbar', { name: 'Download progress' })).toBeTruthy();
    expect(status.textContent).not.toMatch(/dfine|rtmpose|vballnet|D-FINE|RTMPose/i);
    await screen.findByRole('slider', { name: 'Timeline' }, SLOW);
    expect(screen.queryByTestId('preparing')).toBeNull();
  });
});

describe('app flow on the mock engine', () => {
  it('goes from the landing page to results, and focus, frame-step and export work', async () => {
    start('?mock=1,fast');
    await chooseClip();
    await screen.findByRole('slider', { name: 'Timeline' }, SLOW);
    await screen.findByText(/Analysis complete/, undefined, SLOW);
    // the player list sits in a rail on wide screens and in a sheet on narrow ones (the test frame is narrow)
    if (!screen.queryByRole('list', { name: 'Players' }))
      fireEvent.click(screen.getByRole('button', { name: 'Players' }));
    const players = within(await screen.findByRole('list', { name: 'Players' }));
    const first = players.getAllByRole('button', { pressed: false })[0] as HTMLElement;
    fireEvent.click(first);
    await waitFor(() => expect(first.getAttribute('aria-pressed')).toBe('true'));
    useUiStore.getState().close();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(screen.getByTestId('readout').textContent).toContain('f1/');
    fireEvent.keyDown(document.body, { key: '.' });
    await waitFor(() => expect(screen.getByTestId('readout').textContent).toContain('f2/'));
    fireEvent.keyDown(document.body, { key: ',' });
    await waitFor(() => expect(screen.getByTestId('readout').textContent).toContain('f1/'));

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const exportJson = await screen.findByRole('button', { name: 'Export Tracking data' });
    expect((exportJson as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(exportJson);
    await waitFor(() => expect(exportJson.textContent).toBe('Export'));
    expect(screen.queryByRole('alert')).toBeNull();
  }, 60_000);

  it('starts once under React strict mode, which runs effects twice in development', async () => {
    window.history.replaceState(null, '', '/?mock=1,fast');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await chooseClip();
    await screen.findByText(/Analysis complete/, undefined, SLOW);
    expect(screen.queryByRole('alert')).toBeNull();
  }, 60_000);

  it('keeps the analysed part when cancelling mid-run', async () => {
    start('?mock=1');
    await chooseClip();
    const pill = await screen.findByTestId('processing-pill', undefined, SLOW);
    await waitFor(() => expect(useSessionStore.getState().processedFrames).toBeGreaterThan(0));
    fireEvent.click(within(pill).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Keep \d+% analysed$/ }));
    await waitFor(() => expect(screen.queryByTestId('processing-pill')).toBeNull());
    expect(screen.getByRole('slider', { name: 'Timeline' })).toBeTruthy();
    // the engine's partial result replaces the streamed view: partial, with the "only N% analysed" cue
    await waitFor(() => expect(useSessionStore.getState().final).not.toBeNull());
    expect(isPartialResult(useSessionStore.getState().final)).toBe(true);
    expect(screen.getByTestId('partial-cue').textContent).toMatch(/^Partial: only \d+% analysed$/);
  }, 60_000);

  it('exports the kept partial result, with the files marked as partial', async () => {
    start('?mock=1');
    await chooseClip();
    const pill = await screen.findByTestId('processing-pill', undefined, SLOW);
    await waitFor(() => expect(useSessionStore.getState().processedFrames).toBeGreaterThan(0));
    fireEvent.click(within(pill).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Keep \d+% analysed$/ }));
    await waitFor(() => expect(screen.queryByTestId('processing-pill')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/Only the first \d+% of the clip was analysed/)).toBeTruthy();
    const saved = vi.mocked(saveBlob);
    for (const [name, file] of [
      ['Tracking data', /\.partial\.posetrack\.json$/],
      ['Spreadsheet', /\.partial\.posetrack\.csv$/],
      ['Video with skeletons', /\.partial\.overlay\.mp4$/],
    ] as const) {
      const button = screen.getByRole('button', { name: `Export ${name}` }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      saved.mockClear();
      fireEvent.click(button);
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1), SLOW);
      expect(saved.mock.calls[0]?.[1]).toMatch(file);
    }
    expect(screen.queryByRole('alert')).toBeNull();
  }, 60_000);

  it('does not mark the files of a finished analysis as partial', async () => {
    start('?mock=1,fast');
    await chooseClip();
    await screen.findByText(/Analysis complete/, undefined, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.queryByText(/marked partial/)).toBeNull();
    const saved = vi.mocked(saveBlob);
    saved.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'Export Tracking data' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1), SLOW);
    expect(saved.mock.calls[0]?.[1]).toMatch(/\.posetrack\.json$/);
    expect(saved.mock.calls[0]?.[1]).not.toContain('partial');
  }, 60_000);

  it('shows the empty state when nobody is found', async () => {
    start('?mock=1,fast,empty');
    await chooseClip();
    await screen.findByTestId('empty-result', undefined, SLOW);
  }, 60_000);

  it('offers the taxonomy action for an engine error', async () => {
    start('?mock=error:model-load');
    await screen.findByRole('button', { name: 'Try a lighter mode' }, SLOW);
    expect(screen.getByRole('alert').textContent).toContain('model could not be loaded');
  });

  it('shows the device diagnostics at #/about', async () => {
    window.history.replaceState(null, '', '/?mock=1#/about');
    render(<App />);
    expect(await screen.findByTestId('cap-tier', undefined, SLOW)).toBeTruthy();
    expect(screen.getByTestId('ort-selftest')).toBeTruthy();
  });
});
