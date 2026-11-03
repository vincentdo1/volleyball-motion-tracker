import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EngineErrorCode, engineError } from '@/contracts/errors';
import { Problem } from './Problem';

afterEach(cleanup);

function show(code: EngineErrorCode, terminal = false) {
  const handlers = { onRetry: vi.fn(), onFallbackTier: vi.fn(), onNewClip: vi.fn() };
  render(<Problem error={engineError(code, 'details here')} terminal={terminal} {...handlers} />);
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
