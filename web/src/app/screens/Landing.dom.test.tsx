import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { landingPhase } from '../App';
import { useEngineStatus } from '../stores/engine-status';
import { Landing } from './Landing';

afterEach(() => {
  cleanup();
  useEngineStatus.setState({ preparing: false, bytesDone: 0, bytesTotal: 0, downloading: false, percent: 0 });
});

describe('landingPhase', () => {
  it('is never idle once a file was chosen', () => {
    expect(landingPhase('booting', false, true)).toBe('idle');
    expect(landingPhase('booting', true, true)).toBe('preparing');
    expect(landingPhase('probing', true, true)).toBe('preparing');
    expect(landingPhase('probing', true, false)).toBe('opening');
    expect(landingPhase('landing', false, false)).toBe('idle');
  });
});

describe('Landing: Preparing analysis', () => {
  const show = (phase: 'idle' | 'preparing' | 'opening') =>
    render(<Landing onFile={() => undefined} phase={phase} fileName="rally.mp4" mock={false} />);

  it('shows a status at once, with the clip name and no download figure before models download', () => {
    show('preparing');
    const status = screen.getByTestId('preparing');
    expect(status.textContent).toMatch(/Preparing analysis/);
    expect(status.textContent).toMatch(/rally\.mp4/);
    expect(screen.queryByTestId('preparing-progress')).toBeNull();
    expect((screen.getByRole('button', { name: 'Choose video' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the download progress from the model events and never names a model', () => {
    show('preparing');
    act(() => {
      const status = useEngineStatus.getState();
      status.beginPreparing();
      status.addModelProgress('dfine-s-coco.fp16', 10 * 2 ** 20, 40 * 2 ** 20, false);
    });
    expect(screen.getByTestId('preparing-progress').textContent).toBe('25% (10.0 MB of 40.0 MB)');
    expect(screen.getByRole('progressbar', { name: 'Download progress' })).toBeTruthy();
    expect(screen.getByTestId('preparing').textContent).not.toMatch(/dfine|rtmpose|vballnet|D-FINE|ONNX/i);
  });

  it('shows no preparing state on the idle landing and "Opening your clip" while the clip is read', () => {
    show('idle');
    expect(screen.queryByTestId('preparing')).toBeNull();
    expect(screen.getByText('Drop a volleyball clip here')).toBeTruthy();
    cleanup();
    show('opening');
    expect(screen.getByText('Opening your clip')).toBeTruthy();
  });
});
