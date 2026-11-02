import { containTransform, type RenderOptions } from '@/contracts/renderer';
import { createSkeletonRenderer, type FrameSource } from '@/render';

export interface FramePngInput {
  /** The player's `<video>`, paused on the frame to export. */
  readonly video: HTMLVideoElement;
  readonly source: FrameSource | null;
  readonly frameIndex: number;
  readonly options: RenderOptions;
  /** Display size of the clip in px; the picture is exported at this size. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** False exports the plain video frame. */
  readonly overlay: boolean;
}

/** The shown video frame, with the skeleton overlay drawn on top at the clip's own resolution. */
export async function renderFramePng(input: FramePngInput): Promise<Blob> {
  const { video, source, frameIndex, options, displayWidth, displayHeight, overlay } = input;
  const canvas = document.createElement('canvas');
  canvas.width = displayWidth;
  canvas.height = displayHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('the browser could not create a drawing surface');
  ctx.drawImage(video, 0, 0, displayWidth, displayHeight);
  if (overlay && source) {
    const renderer = createSkeletonRenderer();
    try {
      renderer.draw(
        ctx,
        source.frameAt(frameIndex),
        containTransform(displayWidth, displayHeight, displayWidth, displayHeight, 1),
        options,
      );
    } finally {
      renderer.dispose();
    }
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the image could not be encoded'))), 'image/png');
  });
}
