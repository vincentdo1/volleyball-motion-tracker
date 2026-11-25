/** One clip through the UI in WebKit (or Chromium with BROWSER=chromium), then a screenshot of the results view.
 *   PORT=5184 node tests/tools/m2-wk-shot.mjs <clip> <out.png> [wait-ms=1500] */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium, webkit } from '@playwright/test';

const [clip, out, wait = '1500'] = process.argv.slice(2);
const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser =
  process.env.BROWSER === 'chromium'
    ? await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true })
    : await webkit.launch({ headless: true });
const page = await (
  await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })
).newPage();
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 5184}/`);
await page.getByTestId('file-input').setInputFiles(clip);
await page
  .getByRole('status')
  .filter({ hasText: /Analysis complete|No players/ })
  .waitFor({ state: 'attached', timeout: 240000 })
  .catch(() => {});
await page.waitForTimeout(Number(wait));
console.log((await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 300));
await page.screenshot({ path: out });
await browser.close();
