import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../styles/app.css';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { useThemeStore } from '@/ui/theme';
import { App } from './App';
import { useSessionStore } from './stores/session';
import { useSettingsStore } from './stores/settings';
import { type SheetId, useUiStore } from './stores/ui';
import { useViewStore } from './stores/view';

const CLIP = '/__fixtures/videos/volleyball_spike_attempt_03.mp4';
const SLOW = { timeout: 30_000 };

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    // the page background is a video frame; contrast of text over it is judged by the design tokens instead
    rules: { 'color-contrast': { enabled: true } },
  });
  return result.violations.map(
    (v) =>
      `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.any.map((c) => c.message).join('; ')}`).join(' | ')}`,
  );
}

async function chooseClip(): Promise<void> {
  const blob = await (await fetch(CLIP)).blob();
  const file = new File([blob], 'volleyball_spike_attempt_03.mp4', { type: 'video/mp4' });
  fireEvent.change(await screen.findByTestId('file-input'), { target: { files: [file] } });
}

function start(search: string): void {
  window.history.replaceState(null, '', `/${search}`);
  render(<App />);
}

async function openSheet(sheet: SheetId, title: RegExp): Promise<void> {
  useUiStore.getState().show(sheet);
  await screen.findByRole('dialog', { name: title });
  await new Promise((resolve) => setTimeout(resolve, 500)); // slide-in finished
}

beforeEach(() => {
  localStorage.clear();
  useThemeStore.getState().setMotion('reduce'); // sheets and fades are mid-animation otherwise
  useSettingsStore.setState({ dismissedHints: [] });
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clear();
  useViewStore.getState().reset();
  useUiStore.getState().close();
  window.history.replaceState(null, '', '/');
});

describe('axe', () => {
  it('finds no violations on the landing page and its sheets', async () => {
    start('?mock=1');
    await screen.findByTestId('file-input');
    expect(await violations()).toEqual([]);
    await openSheet('privacy', /private/i);
    expect(await violations()).toEqual([]);
    useUiStore.getState().close();
    await openSheet('settings', /settings/i);
    expect(await violations()).toEqual([]);
    useUiStore.getState().close();
    useUiStore.getState().show('shortcuts');
    await screen.findByRole('dialog', { name: /shortcuts/i });
    expect(await violations()).toEqual([]);
  }, 60_000);

  it('finds no violations while processing', async () => {
    start('?mock=1');
    await chooseClip();
    await screen.findByTestId('processing-pill', undefined, SLOW);
    expect(await violations()).toEqual([]);
  }, 60_000);

  it('finds no violations on the results, the panels and the export sheet', async () => {
    start('?mock=1,fast');
    await chooseClip();
    await screen.findByText(/Analysis complete/, undefined, SLOW);
    expect(await violations()).toEqual([]);
    await openSheet('panels', /players and layers/i);
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole('tab', { name: 'Layers' }));
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    expect(await violations()).toEqual([]);
    useUiStore.getState().close();
    await openSheet('export', /export/i);
    expect(await violations()).toEqual([]);
  }, 90_000);

  it('finds no violations on the empty and error states and the about page', async () => {
    start('?mock=1,fast,empty');
    await chooseClip();
    await screen.findByTestId('empty-result', undefined, SLOW);
    expect(await violations()).toEqual([]);
    cleanup();
    start('?mock=error:model-load');
    await screen.findByRole('button', { name: 'Try a lighter mode' }, SLOW);
    expect(await violations()).toEqual([]);
    cleanup();
    window.history.replaceState(null, '', '/?mock=1#/about');
    render(<App />);
    await screen.findByTestId('ort-selftest', undefined, SLOW);
    expect(await violations()).toEqual([]);
  }, 90_000);

  it('finds no violations on a wide screen with the side rail, in the light theme', async () => {
    await page.viewport(1440, 900);
    useThemeStore.getState().setTheme('light');
    try {
      start('?mock=1,fast');
      expect(await violations()).toEqual([]);
      await chooseClip();
      await screen.findByText(/Analysis complete/, undefined, SLOW);
      expect(await screen.findByRole('list', { name: 'Players' })).toBeTruthy();
      expect(await violations()).toEqual([]);
      await openSheet('settings', /settings/i);
      expect(await violations()).toEqual([]);
    } finally {
      useThemeStore.getState().setTheme('system');
      await page.viewport(414, 896);
    }
  }, 90_000);
});
