import { homedir } from 'node:os';
import { chromium } from '@playwright/test';

const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const [q = '', port = '5185'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: chrome, headless: true });
const p = await b.newPage();
p.on('console', (m) => m.type() === 'error' && console.log('[c]', m.text().slice(0, 200)));
await p.goto(`http://127.0.0.1:${port}/tests/tools/m2-probe.html?${q}`);
await p.waitForFunction(() => window.__probe?.done, null, { timeout: 60000 }).catch(() => {});
console.log(await p.locator('#status').innerText());
await b.close();
