import * as ort from 'onnxruntime-web/webgpu';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findModel, modelUrl, ORT_ASSET_BASE, parseModelsLock } from '@/contracts/models';
import type { Rotation } from '@/contracts/posetrack';
import lockJson from '../../../models.lock.json';
import { syntheticImage } from '../__fixtures__/synthetic';
import {
  displaySize,
  mapAffineCrop,
  mapResize,
  NORM_IMAGENET,
  NORM_UNIT,
  type Normalization,
  type PixelImage,
  sampleGray,
  sampleToCHW,
} from './cpu';
import { createFloatBuffer, GpuPreprocessor } from './gpu';

const ROTATIONS: Rotation[] = [0, 90, 180, 270];
/** Bound on the GPU/CPU difference in raw 0..255 units (the work order allows one level; measured below 0.01). */
const TOLERANCE_LEVELS = 0.05;

async function readFloats(device: GPUDevice, buffer: GPUBuffer, elements: number): Promise<Float32Array> {
  const staging = device.createBuffer({ size: elements * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, elements * 4);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}

function toFrame(image: PixelImage): VideoFrame {
  const rgbx = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++) rgbx[i * 4 + c] = image.data[i * image.channels + c] as number;
    rgbx[i * 4 + 3] = 255;
  }
  return new VideoFrame(rgbx, { format: 'RGBX', codedWidth: image.width, codedHeight: image.height, timestamp: 0 });
}

/** Largest |a - b| in raw 0..255 units (the normalisation undone per channel). */
function maxRawError(a: Float32Array, b: Float32Array, norm: Normalization): number {
  const plane = a.length / 3;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const std = norm.std[Math.floor(i / plane)] as number;
    worst = Math.max(worst, Math.abs((a[i] as number) - (b[i] as number)) * std);
  }
  return worst;
}

describe('WGSL pre-processing parity with the CPU reference', () => {
  let device: GPUDevice;
  let gpu: GpuPreprocessor;

  beforeAll(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    device = await adapter.requestDevice();
    gpu = new GpuPreprocessor(device);
  });
  afterAll(() => {
    gpu.dispose();
    device.destroy();
  });

  for (const rotation of ROTATIONS) {
    it(`stretch, crops and gray at rotation ${rotation}`, async () => {
      const image = syntheticImage(31 + rotation, 97, 61, 3);
      const frame = toFrame(image);
      const display = displaySize(image, rotation);

      // Whole-frame stretch (D-FINE style: unit scale, replicated border).
      const stretchSize = 64;
      const stretchBuffer = createFloatBuffer(device, 3 * stretchSize * stretchSize);
      gpu.stretch(frame, rotation, stretchBuffer, stretchSize, stretchSize, NORM_UNIT, 'replicate');
      const stretchCpu = new Float32Array(3 * stretchSize * stretchSize);
      sampleToCHW(
        image,
        rotation,
        stretchCpu,
        0,
        stretchSize,
        stretchSize,
        mapResize(display.width, display.height, stretchSize, stretchSize),
        {
          norm: NORM_UNIT,
          border: 'replicate',
        },
      );
      const stretchError = maxRawError(
        await readFloats(device, stretchBuffer, stretchCpu.length),
        stretchCpu,
        NORM_UNIT,
      );
      expect(stretchError).toBeLessThan(TOLERANCE_LEVELS);

      // Pose crops (ImageNet statistics, black border), one hanging over the frame edge, padded batch of 4.
      const [cropW, cropH, batch] = [48, 64, 4];
      const regions = [
        { cx: display.width * 0.5, cy: display.height * 0.5, w: display.width * 0.4, h: display.height * 0.7 },
        { cx: display.width * 0.95, cy: display.height * 0.9, w: display.width * 0.5, h: display.height * 0.6 },
        { cx: display.width * 0.05, cy: display.height * 0.1, w: display.width * 0.3, h: display.height * 0.4 },
      ];
      const cropBuffer = createFloatBuffer(device, batch * 3 * cropW * cropH);
      gpu.crops(frame, rotation, regions, cropBuffer, cropW, cropH, NORM_IMAGENET, 'zero');
      const cropPlane = 3 * cropW * cropH;
      const cropGpu = await readFloats(device, cropBuffer, batch * cropPlane);
      regions.forEach((region, i) => {
        const expected = new Float32Array(cropPlane);
        sampleToCHW(image, rotation, expected, 0, cropW, cropH, mapAffineCrop(region, cropW, cropH), {
          norm: NORM_IMAGENET,
          border: 'zero',
        });
        expect(maxRawError(cropGpu.subarray(i * cropPlane, (i + 1) * cropPlane), expected, NORM_IMAGENET)).toBeLessThan(
          TOLERANCE_LEVELS,
        );
      });

      // Grayscale into the second plane of a two-plane buffer (the ball clip layout).
      const [grayW, grayH] = [128, 72];
      const grayBuffer = createFloatBuffer(device, 2 * grayW * grayH);
      gpu.gray(frame, rotation, grayBuffer, grayW, grayH, grayW * grayH);
      const grayCpu = new Float32Array(grayW * grayH);
      sampleGray(image, rotation, grayCpu, 0, grayW, grayH);
      const grayGpu = (await readFloats(device, grayBuffer, 2 * grayW * grayH)).subarray(grayW * grayH);
      expect(maxRawError(grayGpu, grayCpu, { mean: [0, 0, 0], std: [255, 255, 255] })).toBeLessThan(TOLERANCE_LEVELS);

      for (const buffer of [stretchBuffer, cropBuffer, grayBuffer]) buffer.destroy();
      frame.close();
    });
  }
});

describe('zero-copy path into onnxruntime', () => {
  it('feeds the ball model from GPU pre-processing like from CPU pre-processing', async () => {
    ort.env.wasm.wasmPaths = ORT_ASSET_BASE;
    const artifact = findModel(parseModelsLock(lockJson), 'vballnet-v4c.fp32');
    const model = new Uint8Array(await (await fetch(modelUrl(artifact))).arrayBuffer());
    const session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] });
    const device = (await ort.env.webgpu.device) as GPUDevice;
    const gpu = new GpuPreprocessor(device);

    const [width, height, frames] = [512, 288, 9];
    const plane = width * height;
    const clipGpu = createFloatBuffer(device, frames * plane);
    const clipCpu = new Float32Array(frames * plane);
    for (let t = 0; t < frames; t++) {
      const image = syntheticImage(100 + t, 160, 90, 3);
      const frame = toFrame(image);
      gpu.gray(frame, 0, clipGpu, width, height, t * plane);
      sampleGray(image, 0, clipCpu, t * plane, width, height);
      frame.close();
    }
    const dims = [1, frames, height, width];
    const viaGpu = await session.run({ clip: ort.Tensor.fromGpuBuffer(clipGpu, { dataType: 'float32', dims }) });
    const viaCpu = await session.run({ clip: new ort.Tensor('float32', clipCpu, dims) });
    const a = (await viaGpu.heatmaps?.getData()) as Float32Array;
    const b = (await viaCpu.heatmaps?.getData()) as Float32Array;
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] as number) - (b[i] as number)));
    expect(a.length).toBe(18 * plane);
    expect(worst).toBeLessThan(1e-3);

    clipGpu.destroy();
    gpu.dispose();
    await session.release();
  });
});
