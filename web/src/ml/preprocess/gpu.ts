/**
 * GPU pre-processing: runs the WGSL sampler of `wgsl/sample.ts` on a decoded `VideoFrame` and writes model inputs into
 * float32 storage buffers that onnxruntime consumes as GPU tensors (`Tensor.fromGpuBuffer`), so a frame never visits
 * the CPU. The buffers must live on ORT's device (`ort.env.webgpu.device`).
 *
 * An external texture expires when the task that imported it ends, so every call imports the frame, encodes and
 * submits synchronously. Calls are ordered on the device queue with the inference runs that follow them.
 */
import type { Rotation } from '@/contracts/posetrack';
import type { CropRegion } from '../geometry';
import {
  type Border,
  displaySize,
  mapAffineCrop,
  mapResize,
  type Normalization,
  orientation,
  type SamplingMap,
} from './cpu';
import { SAMPLE_WGSL } from './wgsl/sample';

/** Most batch items one call can write (the largest pose batch bucket). */
export const MAX_GPU_BATCH = 32;
const UNIFORM_BYTES = 6 * 16;
const MAP_BYTES = 16;
const WORKGROUP = 8;

/** A float32 buffer usable as an ORT GPU tensor and as a compute destination. */
export function createFloatBuffer(device: GPUDevice, elements: number): GPUBuffer {
  return device.createBuffer({
    size: elements * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
}

/** Size of the frame the decoder produced (the external texture covers the visible rectangle), coded orientation. */
function codedSize(frame: VideoFrame) {
  return {
    width: frame.visibleRect?.width ?? frame.codedWidth,
    height: frame.visibleRect?.height ?? frame.codedHeight,
  };
}

interface Job {
  readonly entryPoint: 'chw' | 'gray';
  readonly maps: readonly SamplingMap[];
  readonly dst: GPUBuffer;
  readonly outW: number;
  readonly outH: number;
  /** Elements between batch items. */
  readonly stride: number;
  /** First element written. */
  readonly offset: number;
  readonly norm: Normalization;
  readonly border: Border;
}

export class GpuPreprocessor {
  private readonly pipelines: Record<Job['entryPoint'], GPUComputePipeline>;
  private readonly uniforms: GPUBuffer;
  private readonly mapBuffer: GPUBuffer;
  private readonly layouts: Record<Job['entryPoint'], GPUBindGroupLayout>;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ code: SAMPLE_WGSL });
    const pipeline = (entryPoint: Job['entryPoint']) =>
      device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    this.pipelines = { chw: pipeline('chw'), gray: pipeline('gray') };
    this.layouts = { chw: this.pipelines.chw.getBindGroupLayout(0), gray: this.pipelines.gray.getBindGroupLayout(0) };
    this.uniforms = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.mapBuffer = device.createBuffer({
      size: MAX_GPU_BATCH * MAP_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /** The whole display frame stretched to `outW` x `outH` into `dst[offset ...]` (`3 * outW * outH` floats). */
  stretch(
    frame: VideoFrame,
    rotation: Rotation,
    dst: GPUBuffer,
    outW: number,
    outH: number,
    norm: Normalization,
    border: Border,
    offset = 0,
  ): void {
    const display = displaySize(codedSize(frame), rotation);
    this.run(frame, rotation, {
      entryPoint: 'chw',
      maps: [mapResize(display.width, display.height, outW, outH)],
      dst,
      outW,
      outH,
      stride: 3 * outW * outH,
      offset,
      norm,
      border,
    });
  }

  /** One crop per region into consecutive `[3, outH, outW]` slots of `dst` (at most `MAX_GPU_BATCH`). */
  crops(
    frame: VideoFrame,
    rotation: Rotation,
    regions: readonly CropRegion[],
    dst: GPUBuffer,
    outW: number,
    outH: number,
    norm: Normalization,
    border: Border,
  ): void {
    this.run(frame, rotation, {
      entryPoint: 'chw',
      maps: regions.map((region) => mapAffineCrop(region, outW, outH)),
      dst,
      outW,
      outH,
      stride: 3 * outW * outH,
      offset: 0,
      norm,
      border,
    });
  }

  /** Luma / 255 of the whole display frame stretched to `outW` x `outH` into `dst[offset ...]`. */
  gray(frame: VideoFrame, rotation: Rotation, dst: GPUBuffer, outW: number, outH: number, offset: number): void {
    const display = displaySize(codedSize(frame), rotation);
    this.run(frame, rotation, {
      entryPoint: 'gray',
      maps: [mapResize(display.width, display.height, outW, outH)],
      dst,
      outW,
      outH,
      stride: outW * outH,
      offset,
      norm: { mean: [0, 0, 0], std: [1, 1, 1] },
      border: 'replicate',
    });
  }

  dispose(): void {
    this.uniforms.destroy();
    this.mapBuffer.destroy();
  }

  private run(frame: VideoFrame, rotation: Rotation, job: Job): void {
    if (job.maps.length === 0) return;
    if (job.maps.length > MAX_GPU_BATCH)
      throw new Error(`GPU pre-processing batch of ${job.maps.length} exceeds ${MAX_GPU_BATCH}`);
    const { device } = this;
    const coded = codedSize(frame);
    const display = displaySize(coded, rotation);
    const o = orientation(rotation, display.width, display.height);

    const params = new ArrayBuffer(UNIFORM_BYTES);
    new Uint32Array(params, 0, 8).set([
      job.outW,
      job.outH,
      job.border === 'zero' ? 1 : 0,
      0,
      job.offset,
      job.stride,
      0,
      0,
    ]);
    new Float32Array(params, 32).set([
      o.xx,
      o.xy,
      o.x0,
      0,
      o.yx,
      o.yy,
      o.y0,
      0,
      ...job.norm.mean,
      0,
      1 / job.norm.std[0],
      1 / job.norm.std[1],
      1 / job.norm.std[2],
      0,
    ]);
    device.queue.writeBuffer(this.uniforms, 0, params);
    device.queue.writeBuffer(this.mapBuffer, 0, Float32Array.from(job.maps.flatMap((m) => [m.ax, m.bx, m.ay, m.by])));

    const bindGroup = device.createBindGroup({
      layout: this.layouts[job.entryPoint],
      entries: [
        { binding: 0, resource: device.importExternalTexture({ source: frame }) },
        { binding: 1, resource: { buffer: job.dst } },
        { binding: 2, resource: { buffer: this.uniforms } },
        { binding: 3, resource: { buffer: this.mapBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipelines[job.entryPoint]);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(job.outW / WORKGROUP), Math.ceil(job.outH / WORKGROUP), job.maps.length);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
