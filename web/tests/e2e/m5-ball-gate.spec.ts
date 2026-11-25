import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  dumpProbe,
  type ExportedPoseTrack,
  installProbe,
  outDir,
  readPoseTrack,
  saveJson,
  waitComplete,
} from './m4-support';
import { CASES_DIR, exportFile, isPreview, repoVideo } from './support';

/**
 * Review finding F2: one page (so one engine, one prepared pipeline) analyses two clips in a row. Clip one has nobody and
 * no ball, so after three seconds the ball stage's "no ball yet" gate gives up on the ball model; the review's probe
 * showed that this state survived into the next clip, which then never ran the ball model at all. Clip two is a
 * normal clip: its exported tracks and ball samples (with their source) must equal the same clip analysed in a page
 * that has done nothing before.
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m5-ball-gate
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', acceptDownloads: true });
test.setTimeout(420_000);

const BALLLESS = `${CASES_DIR}/zero_solid.mp4`; // 1280x720, 4 s, one colour: no person, no ball, gate trips after 3 s
const SECOND = 'github_beach_st_lenina_20250622_g1_005.mp4'; // 180 frames, a ball VballNet finds

interface Ball {
  samples: {
    ptsUs: number[];
    xy: (number | null)[];
    radius: (number | null)[];
    confidence: number[];
    visibility: number[];
    source: number[];
  };
}
type Doc = ExportedPoseTrack & { ball: Ball | null };

/** Path of the first difference between two JSON values, or null when they are equal. */
function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object')
    return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const key of keys) {
    const d = firstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}/${key}`);
    if (d) return d;
  }
  return null;
}

const summary = (doc: Doc) => ({
  tier: doc.processing.device.tier,
  frames: doc.frames.ptsUs.length,
  tracks: doc.tracks.length,
  trackIds: doc.tracks.map((t) => t.id),
  ballSamples: doc.ball?.samples.ptsUs.length ?? 0,
  ballVisible: doc.ball?.samples.visibility.filter((v) => v > 0).length ?? 0,
  ballSources: [0, 1, 2].map((s) => doc.ball?.samples.source.filter((x) => x === s).length ?? 0),
});

test('F2: a clip analysed after a ballless clip in the same engine equals the same clip in a fresh page', async ({
  browser,
}) => {
  const dir = outDir('m5-ball-gate');
  mkdirSync(dir, { recursive: true });

  // 1. baseline: the second clip alone in a fresh page
  const baselineContext = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  const fresh = await baselineContext.newPage();
  await fresh.goto('/');
  await fresh.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await fresh.getByTestId('file-input').setInputFiles(repoVideo(SECOND));
  await waitComplete(fresh);
  const baseline = readPoseTrack(await exportFile(fresh, 'json', join(dir, 'baseline'))) as Doc;
  await baselineContext.close();

  // 2. one page, two clips
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  await installProbe(context);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByTestId('file-input').setInputFiles(BALLLESS);
  await expect(page.getByTestId('empty-result')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Choose another clip' }).click();
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 10_000 });
  await page.getByTestId('file-input').setInputFiles(repoVideo(SECOND));
  await waitComplete(page);
  const second = readPoseTrack(await exportFile(page, 'json', join(dir, 'second'))) as Doc;
  const probe = await dumpProbe(page);
  const spawns = probe.log.filter((e) => e.k === 'spawn');
  await context.close();

  const report = {
    baseline: summary(baseline),
    second: summary(second),
    engineSpawns: spawns.length,
    generations: [...new Set(probe.log.map((e) => e.gen))],
    tracksDiff: firstDiff(baseline.tracks, second.tracks),
    ballDiff: firstDiff(baseline.ball, second.ball),
    framesDiff: firstDiff(baseline.frames, second.frames),
  };
  saveJson(dir, 'report.json', report);
  console.log(`ball-gate: ${JSON.stringify(report)}`);

  expect(
    report.baseline.ballVisible,
    'the baseline clip has a ball the model finds (else this test proves nothing)',
  ).toBeGreaterThan(10);
  expect(report.generations, 'one engine worker generation served both clips').toEqual([0]);
  expect(report.second.tier).toBe(report.baseline.tier);
  expect(report.framesDiff, 'frame table').toBeNull();
  expect(report.tracksDiff, 'tracks (ids, boxes, joints) equal the fresh page').toBeNull();
  expect(report.ballDiff, 'ball samples and their source equal the fresh page').toBeNull();
});
