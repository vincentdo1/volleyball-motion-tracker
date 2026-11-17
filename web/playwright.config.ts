import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { defineConfig } from '@playwright/test';

/**
 * E2E against the dev server (default) or the production build (`E2E_TARGET=preview`, run `npm run build` first).
 * `E2E_SERVER=cf` serves that build through the Cloudflare Worker instead of vite preview (wrangler dev with the local
 * R2 simulation; run `npm run cf:seed-local` first), so the production routing and headers are what the tests see.
 * PORT keeps persona worktrees apart (ML 5181, backend 5182, UI 5183, tester 5184).
 * Chrome for Testing 149 in new headless gives a real Metal WebGPU adapter with no flags; override with VBT_CHROME.
 */
const port = Number(process.env.PORT ?? 5173);
const target = process.env.E2E_TARGET === 'preview' ? 'preview' : 'dev';
const cloudflare = process.env.E2E_SERVER === 'cf';
if (cloudflare && target !== 'preview')
  throw new Error('E2E_SERVER=cf tests the production build: set E2E_TARGET=preview');
const serverCommand = cloudflare
  ? `npm run cf:dev -- --ip 127.0.0.1 --port ${port}`
  : target === 'preview'
    ? `npx vite preview --port ${port}`
    : `npx vite --port ${port}`;
const chrome =
  process.env.VBT_CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome-cft',
      use: {
        browserName: 'chromium',
        headless: true,
        launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
      },
    },
  ],
  webServer: {
    command: serverCommand,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
