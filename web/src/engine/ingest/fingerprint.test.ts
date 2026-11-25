import { describe, expect, it } from 'vitest';
import { fingerprintFile } from './fingerprint';

function fakeFile(size: number, lastModified: number, fill = 7): Blob & { lastModified: number } {
  const blob = new Blob([new Uint8Array(size).fill(fill)]);
  return Object.assign(blob, { lastModified });
}

describe('fingerprintFile', () => {
  it('is stable and sha256-prefixed', async () => {
    const a = await fingerprintFile(fakeFile(3 * 1024 * 1024, 1000));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await fingerprintFile(fakeFile(3 * 1024 * 1024, 1000))).toBe(a);
  });

  it('changes with size, lastModified and content', async () => {
    const base = await fingerprintFile(fakeFile(2048, 1));
    expect(await fingerprintFile(fakeFile(2049, 1))).not.toBe(base);
    expect(await fingerprintFile(fakeFile(2048, 2))).not.toBe(base);
    expect(await fingerprintFile(fakeFile(2048, 1, 8))).not.toBe(base);
  });

  it('only reads the first and last MiB of a large file', async () => {
    const big = new Uint8Array(5 * 1024 * 1024);
    const a = await fingerprintFile(Object.assign(new Blob([big]), { lastModified: 5 }));
    big[2 * 1024 * 1024] = 1;
    expect(await fingerprintFile(Object.assign(new Blob([big]), { lastModified: 5 }))).toBe(a);
    big[big.length - 1] = 1;
    expect(await fingerprintFile(Object.assign(new Blob([big]), { lastModified: 5 }))).not.toBe(a);
  });
});
