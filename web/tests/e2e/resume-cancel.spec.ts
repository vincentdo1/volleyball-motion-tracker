import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import { FLAG_SKIPPED, playerRows, readPoseTrack } from './m4-support';
import { exportFile, ffprobe, isPreview, repoVideo, useRealEngine } from './support';

/** M2: cancel (keep / discard), restart after a cancel, and reload mid-run, on the real engine. */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview (M2-2)');
test.use({ serviceWorkers: 'block' });
test.setTimeout(240_000);

const clip = repoVideo('github_beach_st_lenina_20250622_g1_005.mp4');
const golden = clipGolden('github_beach_st_lenina_20250622_g1_005.mp4');

interface Doc {
  extensions?: { partial?: { analysedFrames: number; plannedFrames: number } };
  frames: { ptsUs: number[]; flags: number[] };
  tracks: { id: number; label: string; samples: { ptsUs: number[]; kp: (number | null)[] } }[];
  ball: { samples: { visibility: number[] } } | null;
}
const percent = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    Number((document.querySelector('[data-testid=processing-pill]')?.textContent?.match(/(\d+)%/) ?? [])[1] ?? -1),
  );

async function startAndWait(page: import('@playwright/test').Page, atLeast: number) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(clip);
  await expect.poll(() => percent(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(atLeast);
}

test('discard returns to the landing screen in under 250 ms and the same clip then runs to completion', async ({
  page,
  context,
}) => {
  await useRealEngine(context);
  await startAndWait(page, 30);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByTestId('file-input').waitFor({ state: 'attached' });
  expect(Date.now() - t0).toBeLessThan(250);
  await page.waitForTimeout(600); // a person cannot pick a file sooner; see the M2-8 test for the immediate case
  await page.getByTestId('file-input').setInputFiles(clip);
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: 120_000 });
  expect(await page.locator('ul[aria-label=Players] > li').count()).toBeGreaterThan(5);
});

test('keep partial shows the analysed part and offers the frame PNG', async ({ page, context }) => {
  await useRealEngine(context);
  await startAndWait(page, 30);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /Keep \d+% analysed/ }).click();
  await expect(page.getByTestId('processing-pill')).toHaveCount(0);
  expect(await page.locator('ul[aria-label=Players] > li').count()).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Export Current frame' })).toBeEnabled();
});

test('M2-8: choosing a file right after Discard is accepted (the engine is still cancelling and rejects open with invalid-state)', async ({
  page,
  context,
}) => {
  await useRealEngine(context);
  await startAndWait(page, 30);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByTestId('file-input').setInputFiles(clip);
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: 120_000 });
});

test('M2-4 / F11: a kept partial result exports JSON, CSV and the overlay MP4, and each file has the right content', async ({
  page,
  context,
}) => {
  await useRealEngine(context);
  await startAndWait(page, 30);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /Keep \d+% analysed/ }).click();
  const dir = mkdtempSync(join(tmpdir(), 'vbt-partial-'));
  // the exports wait for the engine's partial result ("Preparing what was analysed..."); the view settles on the same
  // players once that result has replaced the streamed ones, so read the view after the wait
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await expect(page.getByText(/Preparing what was analysed/)).toHaveCount(0, { timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Export Tracking data' })).toBeHidden();
  const viewLabels = (await playerRows(page)).map((r) => r.label);
  expect(viewLabels.length, 'players in the kept view').toBeGreaterThan(0);
  const jsonFile = await exportFile(page, 'json', dir);
  const csvFile = await exportFile(page, 'csv', dir);
  const mp4File = await exportFile(page, 'mp4', dir);

  // JSON: partial header, the golden frame table, and the same people as the view
  const doc = readPoseTrack(jsonFile) as unknown as Doc;
  const partial = doc.extensions?.partial;
  expect(partial, 'JSON carries the partial header').toBeDefined();
  expect(partial?.analysedFrames, 'some frames analysed').toBeGreaterThan(0);
  expect(partial?.analysedFrames).toBeLessThan(partial?.plannedFrames as number);
  expect(partial?.plannedFrames).toBe(golden.video.presentableFrames);
  expect(doc.frames.ptsUs).toEqual(golden.video.ptsUs);
  expect(new Set(doc.tracks.map((t) => t.label)), 'same people as the kept view').toEqual(new Set(viewLabels));
  const skipped = doc.frames.flags.filter((f) => (f & FLAG_SKIPPED) !== 0).length;
  expect(skipped, 'frames not analysed are flagged skipped').toBe(
    golden.video.presentableFrames - (partial?.analysedFrames as number),
  );

  // CSV: exact header, one row per visible joint and ball sample, the same track ids as the JSON
  const lines = readFileSync(csvFile, 'utf8').trimEnd().split('\n');
  expect(lines[0]).toBe(
    'pts_us,time_s,entity,track_id,joint,x_px,y_px,x_norm,y_norm,score,interpolated,low_confidence',
  );
  let rows = 0;
  for (const t of doc.tracks)
    for (let i = 0; i < t.samples.kp.length; i += 3) if (t.samples.kp[i] != null && t.samples.kp[i + 1] != null) rows++;
  rows += doc.ball?.samples.visibility.filter((v) => v > 0).length ?? 0;
  expect(lines.length - 1, 'one row per visible joint and ball sample').toBe(rows);
  const csvIds = new Set(
    lines
      .slice(1)
      .filter((l) => l.split(',')[2] === 'person')
      .map((l) => Number(l.split(',')[3])),
  );
  expect(csvIds, 'CSV track ids are the JSON track ids').toEqual(
    new Set(doc.tracks.filter((t) => t.samples.ptsUs.length > 0).map((t) => t.id)),
  );

  // MP4: every source frame (the part not analysed is drawn without skeletons) and the source's duration
  const probe = ffprobe([
    '-select_streams',
    'v:0',
    '-count_packets',
    '-show_entries',
    'stream=nb_read_packets,duration',
    mp4File,
  ]);
  const stream = (probe.streams ?? [])[0] as { nb_read_packets?: string; duration?: string } | undefined;
  expect(Number(stream?.nb_read_packets), 'MP4 frame count = source frames').toBe(golden.video.presentableFrames);
  const frameS = golden.video.nominalFps.den / golden.video.nominalFps.num;
  const expectedS = ((golden.video.ptsUs.at(-1) as number) - (golden.video.ptsUs[0] as number)) / 1e6 + frameS;
  expect(
    Math.abs(Number(stream?.duration) - expectedS),
    `MP4 duration ${stream?.duration} s against ${expectedS.toFixed(3)} s`,
  ).toBeLessThanOrEqual(1.5 * frameS);
});

test('M2-5: after a reload the same clip offers to continue and skips the finished 10 s chunks (result complete)', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(300_000);
  // Playwright's WebKit refuses OPFS sync access handles ("UnknownError ... transient reason"), so the engine falls back to
  // its in-memory store and a reload loses the chunks. Real Safari is not covered here (M2-17, accepted limitation).
  test.skip(testInfo.project.name.startsWith('webkit'), 'OPFS sync access handles do not work in Playwright WebKit');
  await useRealEngine(context);
  const gtu = repoVideo('github_gtu_20250316_002_volleyball_tracking.mp4'); // chunks are 10 s windows: needs a clip longer than that
  const t0 = Date.now();
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(gtu);
  await expect.poll(() => percent(page), { timeout: 120_000 }).toBeGreaterThanOrEqual(50);
  const halfMs = Date.now() - t0; // progress is close to linear, so a full run is about twice this
  await page.reload();
  await page.getByTestId('file-input').waitFor({ state: 'attached' });
  await page.getByTestId('file-input').setInputFiles(gtu);
  await expect(page.getByRole('dialog')).toContainText(/Continue where you left off/);
  const t1 = Date.now();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: 240_000 });
  expect(Date.now() - t1).toBeLessThan(halfMs * 2 * 0.85);
  expect(await page.locator('ul[aria-label=Players] > li').count()).toBeGreaterThan(20);
});
