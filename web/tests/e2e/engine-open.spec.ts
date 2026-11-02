import { test } from '@playwright/test';
import { clipGoldens } from '../fixtures/clips.ts';

/**
 * M1 backend acceptance: all 11 test clips open with presentable-frame counts and first PTS equal to the ffprobe
 * goldens in tests/fixtures/clips.json.
 */
for (const [clip, golden] of Object.entries(clipGoldens.clips)) {
  test.fixme(`Backend: ${clip} opens with ${golden.video.presentableFrames} presentable frames, first PTS ${golden.video.firstPtsUs} us`, async () => {});
}
