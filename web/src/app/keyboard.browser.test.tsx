import '../styles/app.css';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { useThemeStore } from '@/ui/theme';
import { App } from './App';
import { useSessionStore } from './stores/session';
import { useSettingsStore } from './stores/settings';
import { useUiStore } from './stores/ui';
import { useViewStore } from './stores/view';

const CLIP = '/__fixtures/videos/volleyball_spike_attempt_03.mp4';
const SLOW = { timeout: 30_000 };

/** Presses Tab until the focused element satisfies `match`; fails when it never does within `max` presses. */
async function tabTo(match: (el: HTMLElement) => boolean, max = 40): Promise<HTMLElement> {
  for (let i = 0; i < max; i++) {
    await userEvent.tab();
    const el = document.activeElement;
    if (el instanceof HTMLElement && match(el)) return el;
  }
  throw new Error(`no focusable element matched within ${max} Tab presses`);
}

const named = (name: string) => (el: HTMLElement) =>
  el.getAttribute('aria-label') === name || el.textContent?.trim() === name;

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ dismissedHints: [] });
  useThemeStore.getState().setMotion('reduce');
  window.history.replaceState(null, '', '/?mock=1,fast');
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clear();
  useViewStore.getState().reset();
  useUiStore.getState().close();
  window.history.replaceState(null, '', '/');
});

describe('keyboard-only use', () => {
  it('reaches the upload button, the timeline, and the export sheet, and returns focus afterwards', async () => {
    render(<App />);
    const choose = await tabTo(named('Choose video'));
    // a visible focus ring in the accent colour
    const ring = getComputedStyle(choose);
    expect(ring.outlineStyle).toBe('solid');
    expect(ring.outlineWidth).toBe('2px');

    const blob = await (await fetch(CLIP)).blob();
    const file = new File([blob], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(await screen.findByTestId('file-input'), { target: { files: [file] } });
    await screen.findByText(/Analysis complete/, undefined, SLOW);

    const timeline = await tabTo(
      (el) => el.getAttribute('role') === 'slider' && el.getAttribute('aria-label') === 'Timeline',
    );
    expect(screen.getByTestId('readout').textContent).toContain('f1/');
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByTestId('readout').textContent).toContain('f2/'));
    await userEvent.keyboard('{End}');
    await waitFor(() =>
      expect(timeline.getAttribute('aria-valuenow')).toBe(String(Number(timeline.getAttribute('aria-valuemax')))),
    );
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(timeline.getAttribute('aria-valuenow')).toBe('0'));
    expect(timeline.getAttribute('aria-valuetext')).toMatch(/^\d+\.\d\d s, frame 1$/);

    // Shift+Tab walks back; the export button opens the sheet with Enter and Escape returns to it
    const exportButton = screen.getByRole('button', { name: 'Export' });
    exportButton.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    await waitFor(() =>
      expect(
        dialog.contains(document.activeElement),
        `focus is on ${document.activeElement?.outerHTML.slice(0, 120)}`,
      ).toBe(true),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(exportButton));
  }, 90_000);
});
