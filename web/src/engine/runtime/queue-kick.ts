/**
 * Firefox's WebGPU implementation only polls for completed work every ~100 ms; an empty submit every millisecond
 * wakes it (probe README §5). Only needed on Gecko, and only while frames are being processed.
 */
export class QueueKick {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly device: GPUDevice,
    private readonly intervalMs = 1,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => this.device.queue.submit([]), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
