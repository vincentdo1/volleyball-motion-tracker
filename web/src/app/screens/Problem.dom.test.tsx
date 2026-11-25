import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EngineErrorCode, engineError } from '@/contracts/errors';
import { Problem } from './Problem';

afterEach(cleanup);

function show(code: EngineErrorCode, terminal = false, canFallbackTier = true) {
  const handlers = { onRetry: vi.fn(), onFallbackTier: vi.fn(), onNewClip: vi.fn() };
  render(
    <Problem
      error={engineError(code, 'details here')}
      terminal={terminal}
      canFallbackTier={canFallbackTier}
      {...handlers}
    />,
  );
  return handlers;
}

describe('Problem', () => {
  it('offers retry for a retryable failure', () => {
    const { onRetry } = show('model-download');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('offers the lighter tier when the device cannot run the model', () => {
    const { onFallbackTier } = show('gpu-unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Try a lighter mode' }));
    expect(onFallbackTier).toHaveBeenCalledOnce();
  });

  it('offers a reload or another browser instead of a lighter mode at the lowest tier', () => {
    const { onFallbackTier } = show('gpu-unavailable', false, false);
    expect(screen.queryByRole('button', { name: 'Try a lighter mode' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(screen.getByTestId('browser-hint').textContent).toMatch(/Chrome or Edge/);
    expect(onFallbackTier).not.toHaveBeenCalled();
  });

  it('asks for another file when the clip is unusable', () => {
    const { onNewClip } = show('corrupt-file');
    fireEvent.click(screen.getByRole('button', { name: 'Choose another clip' }));
    expect(onNewClip).toHaveBeenCalledOnce();
  });

  it('suggests another browser and offers no way back when unsupported', () => {
    show('unsupported-browser', true);
    expect(screen.getByText(/recent version of Chrome or Edge/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /try|start over|reload/i })).toBeNull();
  });

  it('keeps runtime output out of the explanation and under Details', () => {
    render(
      <Problem
        error={engineError('inference-failed', "failed to call OrtRun(): Shader 'Pad' parsing error")}
        onRetry={vi.fn()}
        onFallbackTier={vi.fn()}
        onNewClip={vi.fn()}
      />,
    );
    const details = screen.getByText(/OrtRun/);
    expect(details.closest('details')).not.toBeNull();
    expect(screen.getByRole('alert').textContent).not.toMatch(/OrtRun/);
  });
});

describe('Problem: files the browser cannot use (UI/UX 7)', () => {
  const showError = (error: ReturnType<typeof engineError>) =>
    render(<Problem error={error} onRetry={vi.fn()} onFallbackTier={vi.fn()} onNewClip={vi.fn()} />);

  it.each([
    ['hvc1.1.6.L93.B0', 'HEVC (H.265)'],
    ['hev1.2.4.L120.B0', 'HEVC (H.265)'],
    ['av01.0.08M.08', 'AV1'],
    ['vp09.00.10.08', 'VP9'],
    ['avc1.64001F', 'H.264'],
  ])('names %s in words, keeps the identifier in the details and says what to do next', (raw, name) => {
    showError(engineError('unsupported-codec', `This browser cannot decode ${raw} video.`, { codec: raw }));
    const explanation = screen.getByTestId('problem-explanation').textContent as string;
    expect(explanation).toContain(name);
    expect(screen.getByRole('alert').textContent).not.toContain(raw);
    expect(explanation).not.toContain(raw);
    expect(screen.getByTestId('details-line').textContent).toContain(raw);
    expect(screen.getByTestId('next-step').textContent).toMatch(/H\.264 MP4.*Chrome or Edge/);
  });

  it('takes the codec from the message when the engine sent no detail, and copes with an unknown one', () => {
    showError(engineError('unsupported-codec', 'This browser cannot decode hvc1.1.6.L93.B0 video.'));
    expect(screen.getByTestId('problem-explanation').textContent).toContain('HEVC (H.265)');
    cleanup();
    showError(engineError('unsupported-codec', 'This browser cannot decode zzz9 video.', { codec: 'zzz9' }));
    expect(screen.getByTestId('problem-explanation').textContent).toMatch(/video format this browser cannot decode/);
    expect(screen.getByTestId('details-line').textContent).toContain('zzz9');
  });

  it('copies the technical details with the raw identifier', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    showError(
      engineError('unsupported-codec', 'This browser cannot decode hvc1.1.6.L93.B0 video.', {
        codec: 'hvc1.1.6.L93.B0',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    expect(writeText).toHaveBeenCalledOnce();
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toMatch(
      /unsupported-codec \| codec: hvc1\.1\.6\.L93\.B0/,
    );
    vi.unstubAllGlobals();
  });

  it('keeps a damaged file apart from an unsupported codec: its own wording, no codec or browser advice', () => {
    showError(
      engineError('corrupt-file', 'The video stream hvc1.1.6.L93.B0 could not be read to the end.', {
        reason: 'unexpected end of file',
      }),
    );
    const explanation = screen.getByTestId('problem-explanation').textContent as string;
    expect(explanation).toContain('HEVC (H.265)');
    expect(explanation).not.toContain('hvc1');
    const next = screen.getByTestId('next-step').textContent as string;
    expect(next).toMatch(/Copy or download the file again/);
    expect(next).not.toMatch(/Chrome or Edge/);
    expect(screen.getByRole('heading').textContent).toBe('The file looks damaged');
    expect(screen.getByTestId('details-line').textContent).toContain('reason: unexpected end of file');
    expect(screen.getByRole('button', { name: 'Choose another clip' })).toBeTruthy();
  });
});
