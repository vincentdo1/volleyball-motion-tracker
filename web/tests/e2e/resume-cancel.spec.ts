import { test } from '@playwright/test';

/**
 * Backend M1/M3 acceptance through the engine harness (`?debug=1` exposes `window.__engine`): cancel acknowledged in
 * < 250 ms, open VideoFrame counter 0 after a run and after a cancel, resume after reload skips finished chunks, a
 * tampered model gives `model-integrity`, a simulated device loss recovers.
 */
test.fixme('Backend: cancel is acknowledged in under 250 ms and leaves 0 open VideoFrames', async () => {});
test.fixme('Backend: a finished run leaves 0 open VideoFrames', async () => {});
test.fixme('Backend: reload mid-run resumes from the manifest and skips finished chunks', async () => {});
test.fixme('Backend: a corrupted model file surfaces model-integrity', async () => {});
test.fixme('Backend: simulated device loss recovers and finishes the clip', async () => {});
