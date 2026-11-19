import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { outDir, saveJson, waitComplete } from './m4-support';
import { isPreview, repoVideo } from './support';

/**
 * Codex review F5, on the production build with a real irregular clip: 100 frames in the first second, then 10 frames
 * over the next 8.1 s (110 frames, 9.1 s; cut from attempt_04 with ffmpeg, kept outside the repository). The timeline's
 * ruler is time, so a click at 50 % of the track must land at about 4.55 s (the frame on screen then is the one at
 * 3.7 s); a frame-linear lane would land at frame 55, which is 0.55 s. The playhead must stand where the ruler says
 * the shown frame's time is.
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m5-vfr-timeline
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

const CASE = join(homedir(), '.cache/volleyball-motion-tracker/fixtures/m5-cases/vfr_dense_then_sparse.mp4');

/** Cuts the irregular clip when it is missing (ffmpeg and attempt_04 are on the machine; see the recipe). */
function ensureClip(): void {
  if (existsSync(CASE)) return;
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-i',
      repoVideo('volleyball_spike_attempt_04.mp4'),
      '-vf',
      "select='lt(n,110)',setpts='if(lt(N,100),(N/100)/TB,(1+(N-100)*0.9)/TB)'",
      '-fps_mode',
      'passthrough',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '20',
      '-video_track_timescale',
      '90000',
      CASE,
    ],
    { stdio: 'inherit' },
  );
}

test('F5: on a clip with 100 frames in the first second and 10 in the next 8.1 s the timeline is time-linear', async ({
  page,
}) => {
  ensureClip();
  const dir = outDir('m5-vfr-timeline');
  const ptsS = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=p=0',
    CASE,
  ])
    .toString()
    .trim()
    .split('\n')
    .map((l) => Number(l.replace(',', '')))
    .sort((a, b) => a - b);
  expect(ptsS).toHaveLength(110);
  const durationS = ptsS.at(-1) as number; // about where the ruler ends (it may add the last frame's own duration)

  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByTestId('file-input').setInputFiles(CASE);
  await waitComplete(page, 200_000);
  const slider = page.getByRole('slider', { name: 'Timeline' });
  await slider.waitFor({ state: 'visible' });
  const box = (await slider.boundingBox()) as { x: number; y: number; width: number; height: number };

  const read = async () => {
    const text = (await slider.getAttribute('aria-valuetext')) ?? '';
    const timeS = Number(/^([\d.]+) s/.exec(text)?.[1] ?? Number.NaN);
    const frame = Number(/frame (\d+)/.exec(text)?.[1] ?? Number.NaN);
    const left = await slider.evaluate((el) => {
      const head = [...el.querySelectorAll<HTMLElement>('div[aria-hidden]')].find((d) => d.style.left !== '');
      return head ? Number.parseFloat(head.style.left) : Number.NaN;
    });
    return { text, timeS, frame, playheadPercent: left };
  };

  const rows: unknown[] = [];
  for (const fraction of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    await page.mouse.click(box.x + fraction * box.width, box.y + Math.min(8, box.height / 2));
    await page.waitForTimeout(250);
    const now = await read();
    rows.push({ fraction, ...now });
    // the time seeked to is the frame on screen at fraction x duration: within one sparse frame gap (0.9 s) of it
    // (a frame-linear lane would land at frame 55 = 0.55 s for the click at 50 %)
    const wantS = fraction * durationS;
    expect(
      Math.abs(now.timeS - wantS),
      `click at ${fraction}: seeked to ${now.text}, wanted about ${wantS.toFixed(2)} s`,
    ).toBeLessThanOrEqual(1.0);
    // and the playhead stands at that frame's time on the ruler, not at its index share
    expect(
      Math.abs(now.playheadPercent / 100 - now.timeS / durationS),
      `playhead at ${now.playheadPercent} % for ${now.text}`,
    ).toBeLessThan(0.1);
  }
  await page.screenshot({ path: join(dir, 'timeline.png') });
  saveJson(dir, 'report.json', { ptsFirst: ptsS.slice(0, 3), ptsLast: ptsS.slice(-3), durationS, rows });
  console.log(`vfr-timeline: ${JSON.stringify(rows)}`);
});
