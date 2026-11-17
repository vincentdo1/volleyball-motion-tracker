import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeDialog } from './ResumeDialog';

afterEach(cleanup);

function show(doneUs: number) {
  const handlers = { onContinue: vi.fn(), onStartOver: vi.fn(), onClose: vi.fn() };
  render(<ResumeDialog open resume={{ doneUs, chunks: 3, settingsMatch: true }} durationS={10} {...handlers} />);
  return handlers;
}

describe('ResumeDialog', () => {
  it('offers to continue a partly analysed clip and reports the choice', async () => {
    const handlers = show(4_000_000);
    expect(screen.getByText(/40% of this clip was analysed/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(handlers.onContinue).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    });
    expect(handlers.onStartOver).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('says so when the whole clip was analysed before', () => {
    show(10_000_000);
    expect(screen.getByText('You analysed this clip before')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open results' })).toBeTruthy();
  });
});
