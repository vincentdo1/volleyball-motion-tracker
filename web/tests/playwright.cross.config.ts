import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { defineConfig, type PlaywrightTestConfig, type Project } from '@playwright/test';
import base from '../playwright.config.ts';

/**
 * Cross-browser runs (plan M3): WebKit 27.2 headless and Firefox 157 headed (headless Firefox has no WebGPU adapter),
 * on the tests tagged `@cross`. Chrome for Testing stays in the lead's `playwright.config.ts`.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=<scratch>/pw-browsers PORT=5184 npx playwright test -c tests/playwright.cross.config.ts
 *
 * A project whose browser is not installed is left out with a warning, so a run never passes by accident;
 * set VBT_REQUIRE_CROSS=1 (the M3 acceptance run does) to fail instead.
 */
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? `${homedir()}/Library/Caches/ms-playwright`;
const installed = (prefix: string): boolean =>
  existsSync(browsersPath) && readdirSync(browsersPath).some((name) => name.startsWith(`${prefix}-`));

const candidates: { prefix: string; project: Project }[] = [
  {
    prefix: 'webkit',
    project: { name: 'webkit-headless', grep: /@cross/, use: { browserName: 'webkit', headless: true } },
  },
  {
    prefix: 'firefox',
    project: { name: 'firefox-headed', grep: /@cross/, use: { browserName: 'firefox', headless: false } },
  },
];

const projects = candidates.filter(({ prefix, project }) => {
  if (installed(prefix)) return true;
  const message = `${project.name}: no ${prefix} browser under ${browsersPath}; run \`npx playwright install ${prefix}\` (set PLAYWRIGHT_BROWSERS_PATH to keep it out of the default cache)`;
  if (process.env.VBT_REQUIRE_CROSS) throw new Error(message);
  console.warn(`SKIPPED ${message}`);
  return false;
});

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error('the base Playwright config must define a single webServer');

const config: PlaywrightTestConfig = {
  ...base,
  testDir: './e2e',
  outputDir: '../test-results/cross',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report/cross' }]],
  projects: projects.map(({ project }) => project),
  webServer: { ...server, cwd: '..' },
};

export default defineConfig(config);
