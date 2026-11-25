/**
 * M2-5 probe: process a clip to >= N %, reload, choose the same clip again, and report what the app offers (resume dialog
 * or not), the first progress percentage and the time to "Analysis complete". Chunks are 10 s windows (CHUNK_WINDOW_US),
 * so use a clip longer than 10 s and N past the first window.
 *   [BROWSER=webkit] PORT=5184 node tests/tools/m2-resume-probe.mjs <clip.mp4> [percent=50] [continue|startover]
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium, webkit } from '@playwright/test';

const chrome =
  process.env.VBT_CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const clip = process.argv[2] ?? '../test_videos/github_gtu_20250316_002_volleyball_tracking.mp4';
const atLeast = Number(process.argv[3] ?? 50);
const choice = process.argv[4] ?? 'continue';
const port = process.env.PORT ?? '5184';
const pct = (page) =>
  page.evaluate(() =>
    Number((document.querySelector('[data-testid=processing-pill]')?.textContent?.match(/(\d+)%/) ?? [])[1] ?? -1),
  );
const complete = (page, timeout) =>
  page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout });

const browser =
  process.env.BROWSER === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const out = { clip, reloadAtLeast: atLeast };
await page.goto(`http://127.0.0.1:${port}/`);
const t0 = Date.now();
await page.getByTestId('file-input').setInputFiles(clip);
await page.waitForFunction(
  (n) =>
    Number((document.querySelector('[data-testid=processing-pill]')?.textContent?.match(/(\d+)%/) ?? [])[1] ?? -1) >= n,
  atLeast,
  { timeout: 120000 },
);
out.reloadedAtMs = Date.now() - t0;
await page.reload();
await page.getByTestId('file-input').waitFor({ state: 'attached' });
const t1 = Date.now();
await page.getByTestId('file-input').setInputFiles(clip);
const dialog = page.getByRole('dialog');
out.dialog = await dialog
  .waitFor({ state: 'visible', timeout: 6000 })
  .then(async () => (await dialog.innerText()).replace(/\n+/g, ' | '))
  .catch(() => null);
if (out.dialog) {
  await page.getByRole('button', { name: choice === 'continue' ? /Continue|Open results/ : 'Start over' }).click();
}
const t2 = Date.now();
await page
  .waitForFunction(() => document.querySelector('[data-testid=processing-pill]') !== null, null, { timeout: 20000 })
  .catch(() => {});
out.firstPercent = await pct(page);
await complete(page, 300000);
out.rerunWallMs = Date.now() - t1;
out.afterChoiceMs = Date.now() - t2;
out.players = await page.locator('ul[aria-label=Players] > li').count();
console.log(JSON.stringify(out, null, 1));
await browser.close();
