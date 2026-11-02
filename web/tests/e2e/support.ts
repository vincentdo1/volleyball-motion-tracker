import type { Page } from '@playwright/test';
import { clipGoldens } from '../fixtures/clips.ts';

export const clipNames = Object.keys(clipGoldens.clips);

/**
 * Makes sure the capability diagnostics are on screen for a page that already loaded the app. The M0 shell shows them on
 * `/`; the product shell moves them to `/#/about`.
 */
export async function ensureDiagnostics(page: Page): Promise<void> {
  const onRoot = await page
    .getByTestId('cap-isolated')
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!onRoot) {
    await page.goto('/#/about');
    await page.getByTestId('cap-isolated').waitFor({ timeout: 30_000 });
  }
}

/** Dev-server route that serves a clip from the repo's test_videos/. */
export const videoUrl = (clip: string): string => `/__fixtures/videos/${clip}`;
