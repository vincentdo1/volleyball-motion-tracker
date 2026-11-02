import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../stores/settings';
import { Hints } from './Hints';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ dismissedHints: [] });
});
afterEach(cleanup);

describe('Hints', () => {
  it('shows one tip at a time, in order, and remembers dismissals', () => {
    render(<Hints ready={['focus-player', 'frame-step']} done={[]} />);
    expect(screen.getByRole('note').textContent).toMatch(/follow just them/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(screen.getByRole('note').textContent).toMatch(/one frame at a time/);
    expect(JSON.parse(localStorage.getItem('vbt.hints') ?? '[]')).toEqual(['focus-player']);
  });

  it('shows nothing before the moment has come', () => {
    render(<Hints ready={[]} done={[]} />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('marks a tip as seen once the user did the thing', () => {
    const view = render(<Hints ready={['focus-player', 'frame-step']} done={[]} />);
    act(() => view.rerender(<Hints ready={['focus-player', 'frame-step']} done={['focus-player']} />));
    expect(screen.getByRole('note').textContent).toMatch(/one frame at a time/);
  });
});
