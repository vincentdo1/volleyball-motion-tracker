import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';

const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const args = process.argv.slice(2);
const b = await chromium.launch({ executablePath: chrome, headless: true, args });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${process.env.PORT ?? 5184}/#/about`);
await p.getByTestId('cap-tier').waitFor({ timeout: 30000 });
await p.waitForTimeout(2500);
console.log(
  args.join(' '),
  '=>',
  JSON.stringify(
    await p.evaluate(() => ({
      tier: document.querySelector('[data-testid=cap-tier]')?.textContent,
      webgpu: document.querySelector('[data-testid=cap-webgpu]')?.textContent,
      adapter: document.querySelector('[data-testid=cap-adapter]')?.textContent,
      iso: document.querySelector('[data-testid=cap-isolated]')?.textContent,
      ort: document.querySelector('[data-testid=ort-selftest]')?.textContent,
    })),
  ),
);
await b.close();
