import { expect, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import {
  dumpProbe,
  type ExportedPoseTrack,
  type ExportedTrack,
  installProbe,
  outDir,
  playerRows,
  readPoseTrack,
  saveJson,
  waitComplete,
  waitPercent,
} from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * Codex review F1: resume read only the last stored chunk and started allocating track ids from that chunk's own
 * maximum, so a person arriving after the reload could take an earlier person's id (and finalisation, which groups
 * samples by id, then merged two people). gtu is reloaded at about 50 %, resumed with Continue and let finish. Every
 * track first seen after the resume point must have an id above every id of a track seen before it, and no id may be
 * shared by two people; the result is compared with an uninterrupted run of the same clip.
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m5-resume-ids
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.setTimeout(600_000);

const GTU = 'github_gtu_20250316_002_volleyball_tracking.mp4';
const golden = clipGolden(GTU);

const maxOf = (values: number[]): number => values.reduce((m, v) => Math.max(m, v), Number.NEGATIVE_INFINITY);

/** The two groups around a point in time: first seen before it, first seen at or after it. */
function split(tracks: ExportedTrack[], atUs: number) {
  const before = tracks.filter((t) => t.firstPtsUs < atUs);
  const after = tracks.filter((t) => t.firstPtsUs >= atUs);
  return { before, after };
}

/** Largest jump of the box centre between neighbouring samples, in box heights: an identity merge shows as a teleport. */
function worstJump(track: ExportedTrack): number {
  let worst = 0;
  const { box, ptsUs } = track.samples;
  for (let i = 1; i < ptsUs.length; i++) {
    if (box[i * 4] == null || box[(i - 1) * 4] == null) continue;
    const h = Math.max(1, (box[i * 4 + 3] as number) - (box[i * 4 + 1] as number));
    const cx = ((box[i * 4] as number) + (box[i * 4 + 2] as number)) / 2;
    const cy = ((box[i * 4 + 1] as number) + (box[i * 4 + 3] as number)) / 2;
    const px = ((box[(i - 1) * 4] as number) + (box[(i - 1) * 4 + 2] as number)) / 2;
    const py = ((box[(i - 1) * 4 + 1] as number) + (box[(i - 1) * 4 + 3] as number)) / 2;
    const seconds = Math.max(1e-3, ((ptsUs[i] as number) - (ptsUs[i - 1] as number)) / 1e6);
    if (seconds > 0.5) continue; // a gap is not a jump
    worst = Math.max(worst, Math.hypot(cx - px, cy - py) / h / seconds);
  }
  return worst;
}

test('F1: after a resume at about 50 % every new person gets an id above all earlier ones; no id is shared', async ({
  browser,
}) => {
  const dir = outDir('m5-resume-ids');

  // 1. uninterrupted run in its own context
  const baseContext = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  const basePage = await baseContext.newPage();
  await basePage.goto('/');
  await basePage.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await basePage.getByTestId('file-input').setInputFiles(repoVideo(GTU));
  await waitComplete(basePage, 400_000);
  const uninterrupted = readPoseTrack(await exportFile(basePage, 'json', `${dir}/uninterrupted`));
  await baseContext.close();

  // 2. interrupted: reload at about 50 %, Continue, finish
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  await installProbe(context);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByTestId('file-input').setInputFiles(repoVideo(GTU));
  const pctBefore = await waitPercent(page, 50);
  const labelsBefore = (await playerRows(page)).map((r) => r.label);
  await page.reload();
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByTestId('file-input').setInputFiles(repoVideo(GTU));
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Continue' }).click();
  await waitComplete(page, 400_000);
  const dump = await dumpProbe(page);
  const resumed = readPoseTrack(await exportFile(page, 'json', `${dir}/resumed`));
  await context.close();

  const started = dump.log.filter((e) => e.k === 'run-started');
  const resumedFrames = Number(started.at(-1)?.resumedFrames ?? 0);
  expect(resumedFrames, 'the run really resumed from stored chunks').toBeGreaterThan(0);
  const resumeUs = golden.video.ptsUs[resumedFrames] as number;

  const summarise = (doc: ExportedPoseTrack) => {
    const { before, after } = split(doc.tracks, resumeUs);
    return {
      tracks: doc.tracks.length,
      ids: doc.tracks.map((t) => t.id),
      idsUnique: new Set(doc.tracks.map((t) => t.id)).size === doc.tracks.length,
      beforeCount: before.length,
      afterCount: after.length,
      maxIdBefore: maxOf(before.map((t) => t.id)),
      minIdAfter: after.length ? Math.min(...after.map((t) => t.id)) : null,
      afterIds: after.map((t) => t.id),
      worstJumpBH: Math.round(maxOf(doc.tracks.map(worstJump)) * 100) / 100,
      tier: doc.processing.device.tier,
    };
  };
  const u = summarise(uninterrupted);
  const r = summarise(resumed);
  const byId = new Map(uninterrupted.tracks.map((t) => [t.id, t]));
  const sameWindow = resumed.tracks.filter((t) => {
    const o = byId.get(t.id);
    return o && Math.abs(o.firstPtsUs - t.firstPtsUs) < 500_000 && Math.abs(o.lastPtsUs - t.lastPtsUs) < 500_000;
  }).length;
  const report = {
    pctBefore,
    labelsBefore,
    resumedFrames,
    resumeUs,
    started,
    uninterrupted: u,
    resumed: r,
    sameWindow,
  };
  saveJson(dir, 'report.json', report);
  console.log(`resume-ids: ${JSON.stringify(report)}`);

  expect(u.idsUnique && r.idsUnique, 'no id is used by two tracks').toBe(true);
  // the premise on the uninterrupted run: ids rise in order of first appearance
  expect(u.afterCount, 'there are people first seen after the resume point').toBeGreaterThan(0);
  expect(u.minIdAfter as number, 'uninterrupted run: later arrivals have higher ids').toBeGreaterThan(u.maxIdBefore);
  // the finding
  expect(r.afterCount, 'resumed run: people first seen after the resume point').toBeGreaterThan(0);
  expect(r.minIdAfter as number, 'resumed run: every later arrival has an id above all earlier ones').toBeGreaterThan(
    r.maxIdBefore,
  );
  // two people under one id would be fewer tracks than the uninterrupted run and a teleporting track
  expect(r.tracks, 'track count against the uninterrupted run').toBeGreaterThanOrEqual(u.tracks - 3);
  expect(r.worstJumpBH, 'no track teleports (identity merge)').toBeLessThanOrEqual(Math.max(u.worstJumpBH * 1.5, 8));
});
