/** Is the app shell the service worker cached a redirected response? node tests/tools/m5-probe-sw.mjs [port] (M5-4 evidence) */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';

const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const port = process.argv[2] ?? '8787';
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);
await page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
});
const info = await page.evaluate(async () => {
  const names = (await caches.keys()).filter((n) => n.startsWith('vbt-app-'));
  const cache = await caches.open(names[0]);
  const shell = await cache.match('/index.html');
  const root = await cache.match('/');
  return {
    names,
    shell: shell && { status: shell.status, redirected: shell.redirected, type: shell.type, url: shell.url },
    root: Boolean(root),
  };
});
console.log(JSON.stringify(info));
await context.setOffline(true);
const result = await page.reload().then(
  () => 'reload ok',
  (e) => `reload failed: ${String(e).slice(0, 80)}`,
);
console.log(result);
await browser.close();
