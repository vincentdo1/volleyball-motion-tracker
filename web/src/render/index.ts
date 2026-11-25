/**
 * Worker-safe Canvas2D skeleton renderer (05 §2). No DOM globals, no React: it draws on a
 * `CanvasRenderingContext2D` or an `OffscreenCanvasRenderingContext2D`, so the MP4 export worker uses the same code.
 * The caller owns clearing the canvas and drawing the video underneath.
 */

export { assessPose } from './assess';
export { ballAt, createFrameSource, type FrameSource, type FrameSourceOptions, toRenderPlayer } from './frame-source';
export { assignColorSlots } from './palette';
export { createSkeletonRenderer } from './renderer';
