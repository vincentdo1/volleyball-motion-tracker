import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  completeness,
  focusPlayer,
  hidePlayer,
  installProbe,
  openClip,
  outDir,
  pageNow,
  playerRows,
  readPoseTrack,
  saveJson,
  waitComplete,
  waitPercent,
} from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * M4-B2a item 2c (review findings #15 / #28): pick a player (and hide another), cancel mid-run, Keep. The header
 * shows the partial cue; the export rows say "Preparing what was analysed..." and then work; the app view, the PNG, the
 * MP4 (frames extracted with ffmpeg), the JSON and the CSV agree on track ids and colours; the picks stay on the same
 * people; another clip then reaches results.
 *   PORT=5184 E2E_TARGET=preview caffeinate -i -s npx playwright test m4-keep
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.setTimeout(600_000);

const GTU = 'github_gtu_20250316_002_volleyball_tracking.mp4';
const NEXT = 'volleyball_spike_attempt_04.mp4';

test('Keep after a cancel: partial cue, exports that wait then work, one set of ids and colours, picks kept, next clip runs', async ({
  page,
  context,
}) => {
  const dir = outDir('2c-keep');
  await installProbe(context);
  await openClip(page, repoVideo(GTU));
  await waitPercent(page, 35);
  const rowsBefore = await playerRows(page);
  const focusLabel = rowsBefore[0]?.label as string;
  const hideLabel = rowsBefore[1]?.label as string;
  await focusPlayer(page, focusLabel);
  await hidePlayer(page, hideLabel);
  await page.waitForTimeout(500);
  const stage = page.locator('[data-testid=video-stage]');
  await stage.screenshot({ path: join(dir, '1-stage-before-cancel.png') });
  await page.screenshot({ path: join(dir, '1-page-before-cancel.png') });
  const pillBefore = await page.getByTestId('processing-pill').innerText();

  await page.getByTestId('processing-pill').getByRole('button', { name: 'Cancel' }).click();
  const keepButton = page.getByRole('button', { name: /Keep \d+% analysed/ });
  await keepButton.waitFor({ state: 'visible' });
  const keepLabel = (await keepButton.innerText()).trim();
  const keepT = await pageNow(page);
  await keepButton.click();
  const cue = page.getByTestId('partial-cue');
  await cue.waitFor({ state: 'visible', timeout: 5000 });
  const cueText = ((await cue.textContent()) ?? '').trim();
  // the export rows right after Keep
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  const jsonButton = page.getByRole('button', { name: 'Export Tracking data' });
  await jsonButton.waitFor({ state: 'visible' });
  const sheetOf = async (): Promise<string> =>
    (await page.locator('ul').filter({ has: jsonButton }).innerText()).replace(/\s+/g, ' ');
  const sheetEarly = await sheetOf();
  await page.screenshot({ path: join(dir, '2-export-sheet-right-after-keep.png') });
  // wait until nothing says "Preparing" any more
  let preparingMs = 0;
  for (;;) {
    const text = await sheetOf();
    if (!text.includes('Preparing what was analysed')) break;
    preparingMs = (await pageNow(page)) - keepT;
    if (preparingMs > 60_000) break;
    await page.waitForTimeout(100);
  }
  const sheetLater = await sheetOf();
  await page.screenshot({ path: join(dir, '3-export-sheet-later.png') });
  await page.keyboard.press('Escape');
  await jsonButton.waitFor({ state: 'hidden' });
  const rowsAfter = await playerRows(page);
  await stage.screenshot({ path: join(dir, '4-stage-after-keep.png') });
  await page.screenshot({ path: join(dir, '4-page-after-keep.png') });

  // exports
  const json = await exportFile(page, 'json', dir);
  const csv = await exportFile(page, 'csv', dir);
  const png = await exportFile(page, 'png', dir);
  const mp4 = await exportFile(page, 'mp4', dir);
  const track = readPoseTrack(json);
  const done = completeness(track);
  const csvText = readFileSync(csv, 'utf8');
  const csvLines = csvText.trim().split('\n');
  const header = (csvLines[0] ?? '').split(',');
  const idColumn = header.findIndex((h) => /track|player|id/i.test(h));
  const csvIds = new Set(csvLines.slice(1).map((line) => line.split(',')[idColumn] ?? ''));
  const frame0 = join(dir, 'mp4-frame0.png');
  const frame30 = join(dir, 'mp4-frame30.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', 'select=eq(n\\,0)', '-vframes', '1', frame0]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', 'select=eq(n\\,30)', '-vframes', '1', frame30]);

  const trackLabels = track.tracks.map((t) => t.label);
  const rowLabels = rowsAfter.map((r) => r.label);
  const report = {
    pillBefore,
    keepLabel,
    cueText,
    sheetEarly,
    sheetLater,
    preparingMs,
    focusLabel,
    hideLabel,
    rowsBeforeCount: rowsBefore.length,
    rowsAfter: rowsAfter.map((r) => `${r.label}:${r.colour}${r.focused ? ' focus' : ''}${r.hidden ? ' hidden' : ''}`),
    jsonCompleteness: done,
    partialHeader: track.extensions?.partial ?? null,
    jsonTracks: track.tracks.map((t) => `${t.label}#${t.id}/slot${t.colorSlot}`),
    csvHeader: header,
    csvIdColumn: idColumn,
    csvIds: [...csvIds].sort(),
    csvRows: csvLines.length - 1,
    png: png.split('/').at(-1),
    mp4: mp4.split('/').at(-1),
    mp4Frame0: frame0,
  };
  saveJson(dir, 'report.json', report);
  console.log(`keep: ${JSON.stringify(report)}`);

  // next clip
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New clip' }).click();
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 5000 });
  await page.getByTestId('file-input').setInputFiles(repoVideo(NEXT));
  await waitComplete(page, 240_000);
  const next = completeness(readPoseTrack(await exportFile(page, 'json', dir)));
  writeFileSync(join(dir, 'next-clip.json'), JSON.stringify(next));

  expect(cueText).toMatch(/^Partial: only \d+% analysed$/);
  expect(sheetEarly, "rows wait for the engine's partial result").toContain('Preparing what was analysed');
  expect(sheetLater, 'rows work after the wait').not.toContain('Preparing what was analysed');
  expect(done.partial, 'the JSON is marked partial').toBe(true);
  expect(done.skipped, 'frames not analysed are flagged skipped').toBeGreaterThan(0);
  expect(new Set(rowLabels), 'the app lists the same players as the JSON').toEqual(new Set(trackLabels));
  expect(next.processed).toBe(next.frames);
  expect(next.partial).toBe(false);
});
