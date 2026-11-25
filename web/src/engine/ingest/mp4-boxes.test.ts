import { describe, expect, it } from 'vitest';
import { isMissingMoov, readTopLevelBoxes } from './mp4-boxes';

function box(type: string, payloadBytes: number, claimedSize = payloadBytes + 8): Uint8Array {
  const bytes = new Uint8Array(payloadBytes + 8);
  new DataView(bytes.buffer).setUint32(0, claimedSize);
  bytes.set(new TextEncoder().encode(type), 4);
  return bytes;
}

const blob = (...parts: Uint8Array[]) => new Blob(parts as BlobPart[]);

describe('top-level MP4 boxes', () => {
  it('lists the boxes in file order', async () => {
    const file = blob(box('ftyp', 24), box('mdat', 100), box('moov', 40));
    expect((await readTopLevelBoxes(file)).map((b) => [b.type, b.offset, b.size])).toEqual([
      ['ftyp', 0, 32],
      ['mdat', 32, 108],
      ['moov', 140, 48],
    ]);
  });

  it('reads 64-bit sizes and a final box that runs to the end of the file', async () => {
    const wide = box('mdat', 8 + 20, 1);
    new DataView(wide.buffer).setBigUint64(8, BigInt(wide.byteLength));
    const toEnd = box('moov', 12, 0);
    expect((await readTopLevelBoxes(blob(box('ftyp', 8), wide, toEnd))).map((b) => b.type)).toEqual([
      'ftyp',
      'mdat',
      'moov',
    ]);
  });

  it('stops at bytes that are not a box', async () => {
    expect(await readTopLevelBoxes(blob(box('ftyp', 8), new Uint8Array(20).fill(0xff)))).toHaveLength(1);
  });

  it('flags media data without a moov box, also when the mdat is cut short', async () => {
    expect(await isMissingMoov(blob(box('ftyp', 8), box('free', 0), box('mdat', 50, 5000)))).toBe(true);
    expect(await isMissingMoov(blob(box('ftyp', 8), box('mdat', 50), box('moov', 10)))).toBe(false);
    expect(await isMissingMoov(blob(box('ftyp', 8), box('moov', 10)))).toBe(false);
    expect(await isMissingMoov(blob(new TextEncoder().encode('not a video')))).toBe(false);
  });
});
