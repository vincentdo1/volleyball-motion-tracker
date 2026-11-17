import { expect, test } from '@playwright/test';

/**
 * What the app needs from every supported browser (04 §1, §8): cross-origin isolation, a real (non-fallback) WebGPU
 * adapter, WebCodecs and requestVideoFrameCallback. Tagged `@cross` so the cross-browser runner executes it.
 */
test('@cross the browser offers isolation, a real WebGPU adapter, WebCodecs and rVFC', async ({ page }) => {
  await page.goto('/');
  const env = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    const info = adapter?.info as (GPUAdapterInfo & { isFallbackAdapter?: boolean }) | undefined;
    return {
      isolated: self.crossOriginIsolated,
      adapter: adapter ? { vendor: info?.vendor ?? '', fallback: info?.isFallbackAdapter ?? false } : null,
      webCodecs: typeof VideoDecoder === 'function' && typeof VideoFrame === 'function',
      rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    };
  });
  console.log(`${test.info().project.name}: ${JSON.stringify(env)}`);
  expect(env.isolated).toBe(true);
  expect(env.adapter).not.toBeNull();
  expect(env.adapter?.fallback).toBe(false);
  expect(env.webCodecs).toBe(true);
  expect(env.rvfc).toBe(true);
});
