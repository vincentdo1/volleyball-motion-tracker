/**
 * Where model inputs come from. `FrameInputs` hides the two pre-processing paths from the pipeline:
 *  - GPU (WebGPU backend, decoded `VideoFrame`): WGSL kernels write straight into GPU buffers that ORT reads as GPU
 *    tensors.
 *  - CPU (WASM backend, Node, pixel sources): the reference sampler fills `Float32Array` tensors.
 * Either way the frame is opened once per `process()` call and closed when the call settles.
 */
import type { Tensor } from 'onnxruntime-common';
import type { FrameInput, MlRuntime, OrtApi } from '@/contracts/pipeline';
import type { CropRegion } from '../geometry';
import { prepareDetectorInput } from '../models/dfine';
import { POSE_CROP_VALUES, POSE_INPUT_HEIGHT, POSE_INPUT_WIDTH, preparePoseInput } from '../models/rtmpose';
import {
  BALL_CLIP_LENGTH,
  BALL_INPUT_HEIGHT,
  BALL_INPUT_WIDTH,
  BALL_PLANE,
  prepareBallFrame,
} from '../models/vballnet';
import { NORM_IMAGENET, NORM_UNIT, type PixelImage } from '../preprocess/cpu';
import { createFloatBuffer, GpuPreprocessor, MAX_GPU_BATCH } from '../preprocess/gpu';

/** The nine-frame ball input: frames are added one slot at a time, then the whole clip is a tensor. */
export interface BallClip {
  tensor(): Tensor;
  /** Fills slots `filled ... 8` with a copy of slot `filled - 1` (a clip cut short by the end of the video). */
  padFrom(filled: number): void;
}

export interface PreparedFrame {
  detectorTensor(size: number): Tensor;
  poseTensor(regions: readonly CropRegion[], batch: number): Tensor;
  /** Writes this frame (grayscale, 512 x 288) into slot `slot` of the ball clip. */
  addToClip(slot: number): void;
  close(): void;
}

export interface FrameInputs {
  readonly clip: BallClip;
  open(input: FrameInput): Promise<PreparedFrame>;
  dispose(): void;
}

const CLIP_DIMS = [1, BALL_CLIP_LENGTH, BALL_INPUT_HEIGHT, BALL_INPUT_WIDTH];

/** Interleaved RGBA of a decoded frame in coded orientation. */
async function readPixels(input: FrameInput): Promise<PixelImage> {
  const { source } = input;
  if (source.kind === 'pixels') return source;
  const { frame } = source;
  const width = frame.visibleRect?.width ?? frame.codedWidth;
  const height = frame.visibleRect?.height ?? frame.codedHeight;
  const data = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
  await frame.copyTo(data, { format: 'RGBA' });
  return { data, width, height, channels: 4 };
}

class CpuInputs implements FrameInputs {
  private readonly clipData = new Float32Array(BALL_CLIP_LENGTH * BALL_PLANE);
  readonly clip: BallClip = {
    tensor: () => new this.ort.Tensor('float32', this.clipData, CLIP_DIMS),
    padFrom: (filled) => {
      for (let slot = filled; slot < BALL_CLIP_LENGTH; slot++) {
        this.clipData.copyWithin(slot * BALL_PLANE, (filled - 1) * BALL_PLANE, filled * BALL_PLANE);
      }
    },
  };

  constructor(private readonly ort: OrtApi) {}

  async open(input: FrameInput): Promise<PreparedFrame> {
    const image = await readPixels(input);
    const { rotation } = input;
    return {
      detectorTensor: (size) =>
        new this.ort.Tensor('float32', prepareDetectorInput(image, rotation, size), [1, 3, size, size]),
      poseTensor: (regions, batch) =>
        new this.ort.Tensor('float32', preparePoseInput(image, rotation, regions, batch), [
          batch,
          3,
          POSE_INPUT_HEIGHT,
          POSE_INPUT_WIDTH,
        ]),
      addToClip: (slot) => prepareBallFrame(image, rotation, this.clipData, slot * BALL_PLANE),
      close: () => {},
    };
  }

  dispose(): void {}
}

class GpuInputs implements FrameInputs {
  private readonly gpu: GpuPreprocessor;
  private readonly clipBuffer: GPUBuffer;
  private readonly poseBuffer: GPUBuffer;
  private readonly scratch: GPUBuffer;
  private detectorBuffer: { size: number; buffer: GPUBuffer } | null = null;
  readonly clip: BallClip;

  constructor(
    private readonly ort: OrtApi,
    private readonly device: GPUDevice,
  ) {
    this.gpu = new GpuPreprocessor(device);
    this.clipBuffer = createFloatBuffer(device, BALL_CLIP_LENGTH * BALL_PLANE);
    this.poseBuffer = createFloatBuffer(device, MAX_GPU_BATCH * POSE_CROP_VALUES);
    this.scratch = createFloatBuffer(device, BALL_PLANE);
    this.clip = {
      tensor: () => ort.Tensor.fromGpuBuffer(this.clipBuffer, { dataType: 'float32', dims: CLIP_DIMS }),
      padFrom: (filled) => {
        // A buffer cannot be copied onto itself, so the last real plane goes through a scratch plane.
        const plane = BALL_PLANE * 4;
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(this.clipBuffer, (filled - 1) * plane, this.scratch, 0, plane);
        for (let slot = filled; slot < BALL_CLIP_LENGTH; slot++) {
          encoder.copyBufferToBuffer(this.scratch, 0, this.clipBuffer, slot * plane, plane);
        }
        device.queue.submit([encoder.finish()]);
      },
    };
  }

  private detectorBufferFor(size: number): GPUBuffer {
    if (this.detectorBuffer?.size !== size) {
      this.detectorBuffer?.buffer.destroy();
      this.detectorBuffer = { size, buffer: createFloatBuffer(this.device, 3 * size * size) };
    }
    return this.detectorBuffer.buffer;
  }

  async open(input: FrameInput): Promise<PreparedFrame> {
    if (input.source.kind !== 'video-frame') throw new Error('GPU pre-processing needs a VideoFrame source');
    const { frame } = input.source;
    const { rotation } = input;
    return {
      detectorTensor: (size) => {
        const buffer = this.detectorBufferFor(size);
        this.gpu.stretch(frame, rotation, buffer, size, size, NORM_UNIT, 'replicate');
        return this.ort.Tensor.fromGpuBuffer(buffer, { dataType: 'float32', dims: [1, 3, size, size] });
      },
      poseTensor: (regions, batch) => {
        this.gpu.crops(
          frame,
          rotation,
          regions,
          this.poseBuffer,
          POSE_INPUT_WIDTH,
          POSE_INPUT_HEIGHT,
          NORM_IMAGENET,
          'zero',
        );
        return this.ort.Tensor.fromGpuBuffer(this.poseBuffer, {
          dataType: 'float32',
          dims: [batch, 3, POSE_INPUT_HEIGHT, POSE_INPUT_WIDTH],
        });
      },
      addToClip: (slot) =>
        this.gpu.gray(frame, rotation, this.clipBuffer, BALL_INPUT_WIDTH, BALL_INPUT_HEIGHT, slot * BALL_PLANE),
      close: () => {},
    };
  }

  dispose(): void {
    this.gpu.dispose();
    this.clipBuffer.destroy();
    this.poseBuffer.destroy();
    this.scratch.destroy();
    this.detectorBuffer?.buffer.destroy();
  }
}

/** GPU pre-processing on the WebGPU backend (the device is ORT's); CPU pre-processing everywhere else. */
export function createFrameInputs(runtime: MlRuntime): FrameInputs {
  if (runtime.backend === 'webgpu') {
    if (!runtime.device) throw new Error('the webgpu backend needs the ORT GPU device');
    return new GpuInputs(runtime.ort, runtime.device);
  }
  return new CpuInputs(runtime.ort);
}
