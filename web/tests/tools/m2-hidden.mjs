/** Real backgrounded tab (headed Chrome, second tab in front) while a clip is processed. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';

const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const clip = process.argv[2];
const hideMs = Number(process.argv[3] ?? 20000);
const browser = await chromium.launch({
  executablePath: existsSync(chrome) ? chrome : undefined,
  headless: false,
  args: ['--window-size=1200,800'],
});
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: null });
await ctx.route(/engine\.worker-.*\.js(\?.*)?$/, async (route) => {
  const res = await route.fetch();
  await route.fulfill({
    response: res,
    body: (await res.text()).replace('this.inFlight.length>=2', 'this.inFlight.length>=1'),
  });
});
const page = await ctx.newPage();
page.on('close', () => console.log('page closed'));
page.on('crash', () => console.log('page crashed'));
browser.on('disconnected', () => console.log('browser disconnected'));
await page.goto('http://127.0.0.1:5184/');
await page.getByTestId('file-input').setInputFiles(clip);
const pct = () =>
  page.evaluate(() => ({
    pct: Number((document.querySelector('[data-testid=processing-pill]')?.textContent.match(/(\d+)%/) ?? [])[1] ?? -1),
    vis: document.visibilityState,
    done: /complete/.test([...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join('')),
  }));
await page.waitForFunction(
  () =>
    Number((document.querySelector('[data-testid=processing-pill]')?.textContent.match(/(\d+)%/) ?? [])[1] ?? -1) >= 10,
  null,
  { timeout: 60000 },
);
const t0 = Date.now();
const before = await pct();
const cdp = await ctx.newCDPSession(page);
const { windowId } = await cdp.send('Browser.getWindowForTarget');
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
await page.waitForTimeout(hideMs);
const during = await pct();
const t1 = Date.now();
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
await page.bringToFront();
await page.waitForFunction(
  () => /complete/.test([...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join('')),
  null,
  { timeout: 180000 },
);
const players = await page.locator('ul[aria-label=Players] > li').count();
console.log(JSON.stringify({ before, during, hiddenForMs: t1 - t0, totalMs: Date.now() - t0, players }));
await browser.close();
