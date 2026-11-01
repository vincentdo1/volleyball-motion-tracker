import { homedir } from 'node:os';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';
import { viteConfig } from './vite.config.ts';

/** Chrome for Testing gives a real Metal WebGPU adapter in new headless with no flags (probe README §3). */
export const chromeForTesting =
  process.env.VBT_CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const port = Number(process.env.PORT ?? 5173);

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            environment: 'node',
            include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
            exclude: ['**/*.dom.test.*', '**/*.browser.test.*', '**/node_modules/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'dom',
            environment: 'happy-dom',
            include: ['src/**/*.dom.test.{ts,tsx}', 'tests/unit/**/*.dom.test.{ts,tsx}'],
          },
        },
        {
          extends: true,
          // Own server port per worktree (PORT 5181 -> 6181) so it never collides with `npm run dev`.
          server: { port: Number(process.env.VITEST_BROWSER_PORT ?? port + 1000), strictPort: false },
          test: {
            name: 'browser',
            include: ['src/**/*.browser.test.{ts,tsx}'],
            testTimeout: 120_000,
            browser: {
              enabled: true,
              headless: true,
              provider: playwright({ launchOptions: { executablePath: chromeForTesting } }),
              instances: [{ browser: 'chromium' }],
            },
          },
        },
        {
          extends: true,
          test: {
            name: 'harness',
            environment: 'node',
            include: ['src/**/*.harness.ts', 'tests/harness/**/*.harness.ts'],
            testTimeout: 60 * 60_000,
            hookTimeout: 10 * 60_000,
          },
        },
      ],
    },
  }),
);
