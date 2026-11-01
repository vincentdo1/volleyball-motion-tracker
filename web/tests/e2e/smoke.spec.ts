import { expect, test } from '@playwright/test';
import { ORT_ASSET_BASE } from '../../src/contracts/models';

interface SelfTest {
  ok: boolean;
  backend: string;
  outputDims: number[];
  crossOriginIsolated: boolean;
  error: string | null;
}

test('the app is cross-origin isolated, has a real WebGPU adapter and runs ORT in a module worker', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const response = await page.goto('/');
  const headers = response?.headers() ?? {};
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);

  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    if (!a) return null;
    const info = a.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
    return { vendor: info.vendor, architecture: info.architecture, isFallbackAdapter: info.isFallbackAdapter ?? false };
  });
  expect(adapter).not.toBeNull();
  expect(adapter?.isFallbackAdapter).toBe(false);
  expect(`${adapter?.vendor} ${adapter?.architecture}`).not.toMatch(/swiftshader/i);

  await expect(page.getByTestId('cap-isolated')).toHaveText('true');
  await expect(page.getByTestId('cap-webgpu')).toHaveText('real');
  await expect(page.getByTestId('cap-tier')).toHaveText(/^webgpu-/);

  await page.waitForFunction(() => (window as { __ortSelfTest?: unknown }).__ortSelfTest !== undefined, null, {
    timeout: 90_000,
  });
  const selfTest = await page.evaluate(() => (window as unknown as { __ortSelfTest: SelfTest }).__ortSelfTest);
  expect(selfTest.error).toBeNull();
  expect(selfTest).toMatchObject({
    ok: true,
    backend: 'webgpu',
    crossOriginIsolated: true,
    outputDims: [1, 18, 288, 512],
  });
  await expect(page.getByTestId('ort-selftest')).toHaveText('ok');
  console.log(`adapter ${adapter?.vendor}/${adapter?.architecture}; ORT self-test ${JSON.stringify(selfTest)}`);
  expect(pageErrors).toEqual([]);
});

test('ORT runtime files and models are served same-origin with isolation-compatible headers', async ({ request }) => {
  const wasm = await request.get(`${ORT_ASSET_BASE}ort-wasm-simd-threaded.asyncify.wasm`);
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()['content-type']).toContain('application/wasm');
  expect(wasm.headers()['cross-origin-resource-policy']).toBe('same-origin');
  const glue = await request.get(`${ORT_ASSET_BASE}ort-wasm-simd-threaded.asyncify.mjs`, { method: 'HEAD' } as never);
  expect(glue.status()).toBe(200);
  expect(glue.headers()['content-type']).toMatch(/javascript/);
  const model = await request.head('/models/vballnet-v4c.fp32.8eea11cc5c88.onnx');
  expect(model.status()).toBe(200);
  expect(model.headers()['cross-origin-embedder-policy']).toBe('require-corp');
});
