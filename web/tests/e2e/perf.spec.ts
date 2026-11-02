import { test } from '@playwright/test';

/** Performance budgets (plan §6). Timing tests run alone on a quiet machine; budgets are medians/p95 over many samples. */
test.fixme('UI: overlay p95 <= 4 ms at 3840x2160 with 12 players and every layer on (Chrome, M5 Pro)', async ({
  page,
}) => {
  await page.goto('/?debug=1&bench=overlay&players=12&size=3840x2160');
});

test.fixme('Backend/ML: 30 s 1080p30 wide clip processes in <= 60 s with cached models, first skeletons in <= 3 s', async ({
  page,
}) => {
  await page.goto('/?debug=1');
});

test.fixme('ML: median <= 55 ms/frame on the mixed set with GPU preprocessing (M5 Pro)', async ({ page }) => {
  await page.goto('/?debug=1&bench=frames');
});
