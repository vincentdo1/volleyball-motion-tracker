import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { SettingsSheet } from './SettingsSheet';

beforeEach(() => {
  useSettingsStore.setState({ qualityMode: true, dismissedHints: ['export'] });
  useUiStore.getState().show('settings');
});
afterEach(() => {
  cleanup();
  useUiStore.getState().close();
});

describe('Settings: reset preferences (UI/UX 9)', () => {
  it('names the action for what it does and says what it resets and what it leaves alone', () => {
    render(<SettingsSheet />);
    expect(screen.queryByText(/Clear local data/i)).toBeNull();
    const button = screen.getByRole('button', { name: 'Reset preferences' });
    expect(button).toBeTruthy();
    const note = screen.getByText(/back to their defaults/);
    expect(note.textContent).toMatch(/theme, motion, quality mode and the tips/);
    expect(note.textContent).toMatch(/analyses and downloaded models are not touched/);
  });

  it('puts the quality mode and the tips back to their defaults', () => {
    render(<SettingsSheet />);
    act(() => void fireEvent.click(screen.getByRole('button', { name: 'Reset preferences' })));
    expect(useSettingsStore.getState().qualityMode).toBe(false);
    expect(useSettingsStore.getState().dismissedHints).toEqual([]);
  });
});
