import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { clipGoldens } from '../fixtures/clips.ts';
import {
  type ExportedPoseTrack,
  frameAt,
  openClip,
  outDir,
  playerRows,
  readPoseTrack,
  saveJson,
  seekToFrame,
  selectTab,
  setLayer,
  waitComplete,
} from './m4-support';
import { CODEC_DIR, exportFile, isPreview, repoVideo } from './support';

/**
 * M4-B2b: visual QA with the real engine and the real UI. One clip per test: process, export the JSON, then
 *  - h: per frame of the JSON, the tracks present and their colorSlot; worst number of players sharing a slot
 *  - screenshots (stage and page) at the given times, plain, then with a picked player and every focus layer on
 *    (hand trails, ghosts, angles, speed colours)
 *  - j: 'By speed' disabled without a picked player (colour-note), enabled with one
 *  - optionally an MP4 with the picked player and the layers on, frames extracted at the same times (MP4 = app view)
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m4-visual [-g <clip part>]
 * Data: ~/.cache/volleyball-motion-tracker/fixtures/m4-runs/3-<clip>/ (report.json, *.png)
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.setTimeout(900_000);

interface Case {
  readonly name: string;
  readonly file: string;
  readonly times: readonly number[];
  readonly mp4?: boolean;
}

const CASES: readonly Case[] = [
  { name: 'att03', file: repoVideo('volleyball_spike_attempt_03.mp4'), times: [0, 2.6], mp4: true },
  { name: 'beach', file: repoVideo('github_beach_st_lenina_20250622_g1_005.mp4'), times: [0, 2.57], mp4: true },
  { name: 'att04', file: repoVideo('volleyball_spike_attempt_04.mp4'), times: [0, 4], mp4: true },
  { name: 'gtu', file: repoVideo('github_gtu_20250316_002_volleyball_tracking.mp4'), times: [12] },
  {
    name: 'pexels6217335',
    file: repoVideo('pexels_single_spiker_6217335.mp4'),
    times: (process.env.M4_PEXELS_TIMES ?? '1,2,3,4,5,6').split(',').map(Number),
    mp4: !!process.env.M4_PEXELS_MP4,
  },
  { name: 'codec240', file: `${CODEC_DIR}/h264_240fps.mp4`, times: [1] },
  { name: 'codec4k60', file: `${CODEC_DIR}/h264_4k60.mp4`, times: [1] },
  { name: 'codecav1', file: `${CODEC_DIR}/av1_1280x720.mp4`, times: [1] },
];

/** Worst case of players with the same colour slot in one frame, from the exported JSON. */
function slotCollisions(track: ExportedPoseTrack) {
  const perFrame = new Map<number, Map<number, number[]>>();
  for (const t of track.tracks) {
    for (let i = 0; i < t.samples.ptsUs.length; i++) {
      if (!Number.isFinite(t.samples.box[i * 4] as number)) continue;
      const pts = t.samples.ptsUs[i] as number;
      const slots = perFrame.get(pts) ?? new Map<number, number[]>();
      perFrame.set(pts, slots);
      const list = slots.get(t.colorSlot) ?? [];
      list.push(t.id);
      slots.set(t.colorSlot, list);
    }
  }
  let worst = 0;
  let worstPts = -1;
  let framesWithClash = 0;
  let maxOnScreen = 0;
  let distinctSlots = 0;
  const clashPairs = new Set<string>();
  for (const [pts, slots] of perFrame) {
    let onScreen = 0;
    let clash = false;
    for (const [slot, ids] of slots) {
      onScreen += ids.length;
      if (ids.length > 1) {
        clash = true;
        clashPairs.add(`slot${slot}:${ids.join('+')}`);
        if (ids.length > worst) {
          worst = ids.length;
          worstPts = pts;
        }
      }
    }
    if (clash) framesWithClash++;
    if (onScreen > maxOnScreen) {
      maxOnScreen = onScreen;
      distinctSlots = slots.size;
    }
  }
  return {
    frames: perFrame.size,
    maxPlayersOnScreen: maxOnScreen,
    distinctSlotsAtThatFrame: distinctSlots,
    worstSharedSlotCount: worst || 1,
    worstPtsUs: worstPts,
    framesWithClash,
    clashPairs: [...clashPairs].slice(0, 20),
    slotsUsed: [...new Set(track.tracks.map((t) => t.colorSlot))].sort((a, b) => a - b),
  };
}

/** Largest visible track at each time; returns the label with most appearances, then biggest total box height. */
function choosePlayer(track: ExportedPoseTrack, frameIdx: readonly number[]): string {
  const score = new Map<string, { n: number; h: number }>();
  const ptsUs = track.frames.ptsUs;
  for (const f of frameIdx) {
    const pts = ptsUs[f] as number;
    for (const t of track.tracks) {
      const i = t.samples.ptsUs.indexOf(pts);
      if (i < 0) continue;
      const h = (t.samples.box[i * 4 + 3] as number) - (t.samples.box[i * 4 + 1] as number);
      if (!Number.isFinite(h)) continue;
      const s = score.get(t.label) ?? { n: 0, h: 0 };
      s.n++;
      s.h += h;
      score.set(t.label, s);
    }
  }
  return [...score.entries()].sort((a, b) => b[1].n - a[1].n || b[1].h - a[1].h)[0]?.[0] ?? 'P1';
}

for (const c of CASES) {
  test(`visual QA: ${c.name}`, async ({ page }) => {
    const only = process.env.M4_ONLY;
    test.skip(!!only && !only.split(',').includes(c.name), `M4_ONLY=${only}`);
    const dir = outDir(`3-${c.name}`);
    const report: Record<string, unknown> = { clip: c.name, times: c.times };
    await openClip(page, c.file);
    await waitComplete(page, 600_000);
    const json = await exportFile(page, 'json', dir);
    await page.keyboard.press('Escape');
    const track = readPoseTrack(json);
    report.tier = track.processing.device.tier;
    report.backend = track.processing.device.backend;
    report.tracks = track.tracks.length;
    report.frames = track.frames.ptsUs.length;
    report.slots = slotCollisions(track);
    const frameIdx = c.times.map((t) => frameAt(track.frames.ptsUs, t));
    report.frameIdx = frameIdx;
    saveJson(dir, 'report.json', report);
    const stage = page.locator('[data-testid=video-stage]');

    // plain
    await selectTab(page, 'Layers');
    const byWithout = page.getByRole('radio', { name: 'By speed' });
    report.bySpeedDisabledWithoutPick = await byWithout.isDisabled();
    report.bySpeedDescribedBy = await byWithout.getAttribute('aria-describedby');
    report.colourNoteWithoutPick = ((await page.getByTestId('colour-note').textContent()) ?? '').trim();
    report.focusNoteWithoutPick = ((await page.getByTestId('focus-layers-note').textContent()) ?? '').trim();
    const plainSlider: string[] = [];
    const hintVsStage: unknown[] = [];
    for (const [k, f] of frameIdx.entries()) {
      const s = await seekToFrame(page, f);
      plainSlider.push(s.text);
      await stage.screenshot({ path: join(dir, `plain-${c.times[k]}s-stage.png`) });
      await page.screenshot({ path: join(dir, `plain-${c.times[k]}s-page.png`) });
      const hint = await page.getByTestId('hint-strip').boundingBox();
      const st = await stage.boundingBox();
      hintVsStage.push({ hint, stage: st });
    }
    report.plainSlider = plainSlider;
    report.hintVsStage = hintVsStage;
    saveJson(dir, 'report.json', report);

    // picked + every focus layer
    const label = choosePlayer(track, frameIdx);
    report.picked = label;
    await selectTab(page, 'Players');
    await page
      .locator('ul[aria-label=Players] > li')
      .filter({ has: page.getByRole('button', { name: `Hide ${label}`, exact: true }) })
      .locator('button')
      .first()
      .click();
    await selectTab(page, 'Layers');
    for (const layer of ['Hand trails', 'Ghosts', 'Angles']) await setLayer(page, layer, true);
    report.bySpeedEnabledWithPick = await byWithout.isEnabled();
    report.colourNoteWithPick = ((await page.getByTestId('colour-note').textContent()) ?? '').trim();
    await page.getByRole('radio', { name: 'By speed' }).check({ force: true });
    report.rows = (await playerRows(page)).map((r) => `${r.label}:${r.colour}${r.focused ? ':focus' : ''}`);
    const focusNotes: { t: number | undefined; note: string }[] = [];
    report.focusNotes = focusNotes;
    for (const [k, f] of frameIdx.entries()) {
      await seekToFrame(page, f);
      await page.waitForTimeout(500);
      const note = ((await page.getByTestId('focus-layers-note').textContent()) ?? '').trim();
      focusNotes.push({ t: c.times[k], note });
      await stage.screenshot({ path: join(dir, `picked-${c.times[k]}s-stage.png`) });
      await page.screenshot({ path: join(dir, `picked-${c.times[k]}s-page.png`) });
    }
    saveJson(dir, 'report.json', report);

    // MP4 = app view
    if (c.mp4) {
      const mp4 = await exportFile(page, 'mp4', dir);
      report.mp4 = mp4;
      for (const [k, f] of frameIdx.entries()) {
        execFileSync('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-i',
          mp4,
          '-vf',
          `select=eq(n\\,${f})`,
          '-vframes',
          '1',
          join(dir, `mp4-${c.times[k]}s.png`),
        ]);
      }
      saveJson(dir, 'report.json', report);
    }
    const goldens = clipGoldens.clips[c.file.split('/').at(-1) as string];
    if (goldens) expect(track.frames.ptsUs.length).toBe(goldens.video.presentableFrames);
    console.log(`visual ${c.name}: ${JSON.stringify(report).slice(0, 1500)}`);
  });
}
