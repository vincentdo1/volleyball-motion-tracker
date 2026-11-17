import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ensureDiagnostics } from './support';

/** Zero axe violations (WCAG 2.2 AA) on every screen; screens are added here as the UI lands them. */
async function violations(page: import('@playwright/test').Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`);
}

for (const theme of ['dark', 'light'] as const) {
  test(`diagnostics page has no axe violations in the ${theme} theme`, async ({ page }) => {
    await page.goto('/');
    await ensureDiagnostics(page);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await violations(page)).toEqual([]);
  });
}

test.fixme('UI: landing, processing, results, export sheet, settings and every error state have no axe violations', async ({
  page,
}) => {
  for (const url of ['/?mock=1', '/?mock=1&screen=results', '/?mock=error:model-download']) {
    await page.goto(url);
    expect(await violations(page), url).toEqual([]);
  }
});

test.fixme('UI: keyboard-only path upload -> processing -> results -> export completes without a pointer', async () => {
  // Tab to the file input, press Enter/Space to choose clips/attempt via setInputFiles, Tab through Start, and so on.
});
