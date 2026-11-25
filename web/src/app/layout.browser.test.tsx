import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../styles/app.css';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { App } from './App';
import { useSessionStore } from './stores/session';
import { useSettingsStore } from './stores/settings';
import { useUiStore } from './stores/ui';
import { useViewStore } from './stores/view';

const CLIP = '/__fixtures/videos/volleyball_spike_attempt_03.mp4';
const SLOW = { timeout: 30_000 };
const VIEWPORTS = [
  [1440, 900],
  [1280, 720],
  [414, 896],
  [844, 390],
] as const;

afterEach(async () => {
  cleanup();
  useSessionStore.getState().clear();
  useViewStore.getState().reset();
  useUiStore.getState().close();
  useSettingsStore.setState({ dismissedHints: [] });
  window.history.replaceState(null, '', '/');
  await page.viewport(414, 896);
});

describe('results layout with a crowd', () => {
  it.each(VIEWPORTS)(
    'keeps the video usable and scrolls the lanes at %ix%i',
    async (width, height) => {
      await page.viewport(width, height);
      window.history.replaceState(null, '', '/?mock=1,fast,crowd');
      render(<App />);
      const blob = await (await fetch(CLIP)).blob();
      const file = new File([blob], 'volleyball_spike_attempt_03.mp4', { type: 'video/mp4' });
      fireEvent.change(await screen.findByTestId('file-input'), { target: { files: [file] } });
      await screen.findByText(/Analysis complete/, undefined, SLOW);

      const stage = screen.getByTestId('video-stage').getBoundingClientRect();
      expect(stage.height).toBeGreaterThanOrEqual(height * 0.33);
      // the first-run hint card is shown (hints were reset) and never covers the video
      const hint = (await screen.findByTestId('hint')).getBoundingClientRect();
      expect(hint.top).toBeGreaterThanOrEqual(stage.bottom - 0.5);
      const scroller = screen.getByTestId('timeline-scroller');
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(height);
    },
    60_000,
  );
});
