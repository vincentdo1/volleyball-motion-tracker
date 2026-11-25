import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import { outDir, playerRows, saveJson, sliderState, waitComplete } from './m4-support';
import { isPreview, repoVideo } from './support';

/**
 * Plan M1 criterion "keyboard upload to export": from the landing screen, with the keyboard only (Tab, Shift+Tab,
 * Enter, Space, arrow keys; the file chooser is answered through the chooser event, not by clicking), reach the
 * results, pick a player, step the timeline, open Export and download the JSON. The spec never calls click().
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m5-keyboard
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.setTimeout(300_000);

const CLIP = 'volleyball_spike_attempt_04.mp4';
const golden = clipGolden(CLIP);

interface Focus {
  tag: string;
  name: string;
  role: string;
  inPlayers: boolean;
  outlineWidth: string;
  outlineStyle: string;
}

const focused = (page: Page): Promise<Focus> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const style = el ? getComputedStyle(el) : null;
    return {
      tag: el?.tagName ?? '',
      name: el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '',
      role: el?.getAttribute('role') ?? '',
      inPlayers: Boolean(el?.closest('ul[aria-label=Players]')),
      outlineWidth: style?.outlineWidth ?? '',
      outlineStyle: style?.outlineStyle ?? '',
    };
  });

/** Presses Tab (or Shift+Tab) until the focused element satisfies `match`. Returns it and the presses it took. */
async function tabTo(page: Page, match: (f: Focus) => boolean, max = 60, back = false) {
  for (let presses = 1; presses <= max; presses++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const f = await focused(page);
    if (match(f)) return { focus: f, presses };
  }
  throw new Error(`no focusable element matched within ${max} presses; last: ${JSON.stringify(await focused(page))}`);
}

test('M1: keyboard only, landing -> results -> pick a player -> Export -> JSON download', async ({ page }) => {
  const dir = outDir('m5-keyboard');
  const steps: Record<string, unknown> = {};
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });

  // landing: the primary button
  const choose = await tabTo(page, (f) => f.tag === 'BUTTON' && /Choose video/i.test(f.name));
  steps.choose = choose;
  expect(choose.focus.outlineStyle, 'a visible focus ring on the upload button').toBe('solid');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles(repoVideo(CLIP));
  await waitComplete(page, 240_000);
  await page.screenshot({ path: join(dir, '1-results.png') });

  // pick a player: Tab into the Players list and press Space on its first button (focus player)
  const rows = await playerRows(page);
  expect(rows.length, 'players found').toBeGreaterThanOrEqual(2);
  const player = await tabTo(page, (f) => f.inPlayers && f.tag === 'BUTTON', 80);
  steps.player = player;
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const after = await playerRows(page);
  steps.rowsAfterPick = after.map((r) => `${r.label}${r.focused ? ' focus' : ''}${r.solo ? ' solo' : ''}`);
  expect(
    after.some((r) => r.focused),
    'a player is picked by keyboard',
  ).toBe(true);

  // timeline: arrows step frames
  const slider = await tabTo(page, (f) => f.role === 'slider' && /Timeline/i.test(f.name), 80);
  steps.slider = slider;
  const s0 = await sliderState(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const s1 = await sliderState(page);
  steps.sliderMove = { from: s0.frame, to: s1.frame };
  expect(s1.frame, 'ArrowRight steps the timeline').toBeGreaterThan(s0.frame);

  // Export: open the sheet with Enter, then the JSON row with Enter
  const exportButton = await tabTo(page, (f) => f.tag === 'BUTTON' && /^Export$/.test(f.name), 80, true);
  steps.exportButton = exportButton;
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Export Tracking data' })).toBeVisible();
  const json = await tabTo(page, (f) => f.tag === 'BUTTON' && /Export Tracking data/.test(f.name), 40);
  steps.jsonRow = json;
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.keyboard.press('Space'),
  ]);
  const file = join(dir, download.suggestedFilename());
  await download.saveAs(file);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { frames: { ptsUs: number[] }; tracks: unknown[] };
  steps.download = { file: download.suggestedFilename(), tracks: doc.tracks.length, frames: doc.frames.ptsUs.length };
  saveJson(dir, 'steps.json', steps);
  console.log(`keyboard: ${JSON.stringify(steps)}`);

  expect(doc.frames.ptsUs, 'JSON keyed by the golden frame PTS table').toEqual(golden.video.ptsUs);
  expect(doc.tracks.length).toBeGreaterThanOrEqual(2);
});
