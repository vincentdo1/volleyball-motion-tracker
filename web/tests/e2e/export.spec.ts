import { test } from '@playwright/test';

/**
 * M3 export acceptance. JSON: validate with ajv 2020 against `src/contracts/posetrack.schema.json`. CSV: header and
 * row count (frames x people x joints). PNG: dimensions equal the display size. MP4: read back with mediabunny in the
 * page, frame count and timestamps equal the source's presentable frames, audio passthrough, A/V start offset <= 1 frame
 * on the edit-list clip (attempt_03).
 */
test.fixme('UI/Backend: JSON export validates against posetrack.schema.json', async () => {});
test.fixme('UI/Backend: CSV export has the documented header and one row per person-joint-frame', async () => {});
test.fixme('UI: PNG frame export has the display size of the clip', async () => {});
test.fixme('Backend: MP4 overlay export keeps the presentable frame count, timestamps and audio (attempt_03)', async () => {});
