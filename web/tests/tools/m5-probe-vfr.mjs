/** Opens one clip in the production build and prints the error screen's Details (M5 probe). node tests/tools/m5-probe-vfr.mjs <clip> [port] */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';

const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const [clip, port = '5184'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${String(e).slice(0, 300)}`));
await page.goto(`http://127.0.0.1:${port}/`);
await page.getByTestId('file-input').setInputFiles(clip);
await page.getByRole('alert').waitFor({ timeout: 60000 });
await page.getByText('Details', { exact: true }).click();
console.log((await page.locator('body').innerText()).replace(/\s+/g, ' '));
console.log(logs.join('\n'));
await browser.close();
