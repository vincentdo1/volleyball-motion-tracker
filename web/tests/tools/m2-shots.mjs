/**
 * Visual QA: processes one clip through the real UI, then screenshots the results view at given times (seconds).
 *   node tests/tools/m2-shots.mjs --clip <mp4> --times 0,2.6 --out <dir> [--port 5184] [--w 1440] [--h 900] [--name x]
 * Seeks with the timeline slider (click, then arrow keys until the aria-valuetext time is the closest frame).
 * Prints, per shot, the video stage size and the slider text.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values: a } = parseArgs({
  options: {
    clip: { type: 'string' },
    times: { type: 'string', default: '0' },
    out: { type: 'string' },
    port: { type: 'string', default: process.env.PORT ?? '5184' },
    w: { type: 'string', default: '1440' },
    h: { type: 'string', default: '900' },
    name: { type: 'string', default: '' },
  },
});
const chrome =
  process.env.VBT_CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(a.out, { recursive: true });
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
const ctx = await browser.newContext({
  serviceWorkers: 'block',
  viewport: { width: Number(a.w), height: Number(a.h) },
});
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${a.port}/`);
await page.getByTestId('file-input').waitFor({ state: 'attached' });
await page.getByTestId('file-input').setInputFiles(a.clip);
await page
  .getByRole('status')
  .filter({ hasText: /Analysis complete/ })
  .waitFor({ state: 'attached', timeout: 600000 });
const slider = page.getByRole('slider', { name: 'Timeline' });
const readTime = async () => {
  const t = (await slider.getAttribute('aria-valuetext')) ?? '';
  return { text: t, s: Number(/^([\d.]+) s/.exec(t)?.[1] ?? Number.NaN) };
};
const name = a.name || basename(a.clip, '.mp4');
for (const target of a.times.split(',').map(Number)) {
  const box = await slider.boundingBox();
  const max = Number(await slider.getAttribute('aria-valuemax'));
  // the track does not span the whole slider box, so seek by keys: Home, then ArrowRight until the time is the closest frame
  await slider.focus();
  await page.keyboard.press('Home');
  let cur = await readTime();
  for (let i = 0; i < 2000 && cur.s < target - 0.5 / 30; i++) {
    await page.keyboard.press('ArrowRight');
    let next = await readTime();
    for (let k = 0; k < 25 && next.s === cur.s; k++) {
      await page.waitForTimeout(40);
      next = await readTime();
    }
    if (next.s === cur.s) break;
    cur = next;
  }
  await page.waitForTimeout(500);
  const stage = await page.getByTestId('video-stage').boundingBox();
  const file = join(a.out, `${name}-t${target.toFixed(2)}.png`);
  await page.screenshot({ path: file });
  console.log(
    JSON.stringify({
      clip: name,
      target,
      at: cur.text,
      max,
      stage: stage && [Math.round(stage.width), Math.round(stage.height)],
      file,
    }),
  );
}
await browser.close();
