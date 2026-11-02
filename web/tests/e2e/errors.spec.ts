import { expect, test } from '@playwright/test';
import { ERROR_DEFAULTS } from '../../src/contracts/errors';

/**
 * Every engine error code has a title and a recovery action in the contract (`ERROR_DEFAULTS`). With the mock engine
 * (`?mock=error:<code>`) the UI must show that title in an alert and offer the contract's action. Enabled by the UI
 * persona's error states (05 §4.7).
 */
for (const [code, info] of Object.entries(ERROR_DEFAULTS)) {
  test.fixme(`UI: ?mock=error:${code} shows "${info.title}" and the "${info.action}" action`, async ({ page }) => {
    await page.goto(`/?mock=error:${code}`);
    await page.getByTestId('file-input').setInputFiles('test_videos/volleyball_spike_attempt_04.mp4');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(info.title);
    if (info.action !== 'none') await expect(alert.getByRole('button').first()).toBeVisible();
  });
}
