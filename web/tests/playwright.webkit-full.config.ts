import { defineConfig } from '@playwright/test';
import base from './playwright.cross.config.ts';

/**
 * WebKit 27.2 (headless) full real-engine run: every real-engine spec of the Chrome suite except perf timing.
 *   E2E_TARGET=preview PORT=5184 npx playwright test -c tests/playwright.webkit-full.config.ts
 */
export default defineConfig({
  ...base,
  outputDir: '../test-results/webkit-full',
  reporter: [['list']],
  testMatch: /(engine-open|export|errors|resume-cancel|cross-e2e|smoke)\.spec\.ts/,
  projects: [{ name: 'webkit-full', use: { browserName: 'webkit', headless: true } }],
});
