import { commands } from 'vitest/browser';

/** Fraction of pixels allowed to differ (anti-aliasing and font hinting differences between runs). */
const MAX_DIFFERING_SHARE = 0.002;
const CHANNEL_TOLERANCE = 24;

const GOLDEN_DIR = 'src/render/__golden__';

/** Set `VITE_UPDATE_GOLDEN=1` to (re)write goldens instead of comparing. */
const update = import.meta.env.VITE_UPDATE_GOLDEN === '1';

function toBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').split(',')[1] as string;
}

async function decode(base64: string): Promise<ImageData> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** Compares a canvas with `__golden__/<name>.png`, or writes it when updating. Returns the differing share. */
export async function matchGolden(canvas: HTMLCanvasElement, name: string): Promise<number> {
  const path = `${GOLDEN_DIR}/${name}.png`;
  const actual = toBase64(canvas);
  if (update) {
    await commands.writeFile(path, actual, 'base64');
    return 0;
  }
  const expected = await commands.readFile(path, 'base64');
  const [a, b] = await Promise.all([decode(actual), decode(expected)]);
  if (a.width !== b.width || a.height !== b.height) return 1;
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(
      Math.abs((a.data[i] as number) - (b.data[i] as number)),
      Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)),
      Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)),
    );
    if (delta > CHANNEL_TOLERANCE) differing++;
  }
  return differing / (a.width * a.height);
}

export { MAX_DIFFERING_SHARE };
