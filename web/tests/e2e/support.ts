import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { BrowserContext, Download, Page } from '@playwright/test';
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

// ---------------------------------------------------------------------------------------------------------------------
// M2: real engine (no ?mock). Run against the production build: `PORT=5184 E2E_TARGET=preview npm run test:e2e`.
// The `vite` dev server shows the "Initialising is not available while the engine is initializing" error screen
// because StrictMode initialises the engine twice (M2-2), so real-engine suites skip themselves on the dev server.
// ---------------------------------------------------------------------------------------------------------------------

export const repoVideo = (clip: string): string => resolve(import.meta.dirname, '../../../test_videos', clip);
export const CODEC_DIR = `${process.env.HOME}/.cache/volleyball-motion-tracker/fixtures/codecs`;
export const CASES_DIR = `${process.env.HOME}/.cache/volleyball-motion-tracker/fixtures/m2-cases`;
export const isPreview = process.env.E2E_TARGET === 'preview';

/**
 * M2-1 is fixed (one frame at a time inside the pipeline, supervised worker), so the old test-side rewrite of the
 * engine chunk is gone. `useRealEngine` stays as a hook so every suite keeps one place to prepare a context.
 */
export const workaroundM21 = false;

export async function useRealEngine(_context: BrowserContext): Promise<void> {}

export interface Processed {
  wallMs: number;
  /** Page clock from choosing the file to the first player entry in the list. */
  firstPlayerMs: number | null;
  players: number;
}

/** Opens the app, chooses the file through the UI and waits until the results view reports the analysis complete. */
export async function processClip(page: Page, file: string, timeoutMs = 240_000): Promise<Processed> {
  await page.addInitScript(() => {
    const w = window as unknown as { __firstPlayerAt?: number };
    new MutationObserver(() => {
      if (w.__firstPlayerAt === undefined && document.querySelector('ul[aria-label=Players] > li'))
        w.__firstPlayerAt = performance.now();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached' });
  const picked = await page.evaluate(() => performance.now());
  const start = Date.now();
  await page.getByTestId('file-input').setInputFiles(file);
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: timeoutMs });
  const wallMs = Date.now() - start;
  const first = await page.evaluate(() => (window as unknown as { __firstPlayerAt?: number }).__firstPlayerAt ?? null);
  return {
    wallMs,
    firstPlayerMs: first === null ? null : Math.round(first - picked),
    players: await page.locator('ul[aria-label=Players] > li').count(),
  };
}

export const EXPORT_TITLES = {
  json: 'Tracking data',
  csv: 'Spreadsheet',
  png: 'Current frame',
  mp4: 'Video with skeletons',
} as const;

/** Opens the export sheet (once) and downloads one format; resolves with the saved file path. */
export async function exportFile(page: Page, kind: keyof typeof EXPORT_TITLES, dir: string): Promise<string> {
  const button = page.getByRole('button', { name: `Export ${EXPORT_TITLES[kind]}` });
  if (!(await button.isVisible())) await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300_000 }), button.click()]);
  const path = `${dir}/${download.suggestedFilename()}`;
  await (download as Download).saveAs(path);
  return path;
}

export interface ProbeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  start_time?: string;
  duration?: string;
}
export function ffprobe(args: string[]): {
  streams?: ProbeStream[];
  frames?: { pts_time: string }[];
  format?: { duration: string };
} {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...args], { maxBuffer: 1 << 28 }).toString(),
  );
}
