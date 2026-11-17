import { afterEach, expect, it } from 'vitest';
import './harness';

afterEach(async () => {
  await window.__engineHarness.dispose();
});

it('exposes a harness that processes a fixture clip with the stub ML module', async () => {
  const run = await window.__engineHarness.run('volleyball_spike_attempt_04.mp4', {
    useStub: true,
    init: { tierOverride: 'webgpu-default' },
  });
  expect(run.result.frames.ptsUs.length).toBe(181);
  expect(run.events.some((e) => e.type === 'progress')).toBe(true);
  expect(window.__engineHarness.engine?.state).toBe('done');
});
