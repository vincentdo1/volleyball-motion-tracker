const MIB = 1024 * 1024;

export interface FingerprintSource {
  readonly size: number;
  readonly lastModified: number;
  slice(start?: number, end?: number): Blob;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256:<hex>` over the first MiB, the last MiB (never overlapping), the size and lastModified (plan §3.12). */
export async function fingerprintFile(file: FingerprintSource): Promise<string> {
  const head = await file.slice(0, Math.min(MIB, file.size)).arrayBuffer();
  const tailStart = Math.max(MIB, file.size - MIB);
  const tail = tailStart < file.size ? await file.slice(tailStart, file.size).arrayBuffer() : new ArrayBuffer(0);
  const input = new Uint8Array(head.byteLength + tail.byteLength + 16);
  input.set(new Uint8Array(head), 0);
  input.set(new Uint8Array(tail), head.byteLength);
  const view = new DataView(input.buffer);
  view.setBigUint64(head.byteLength + tail.byteLength, BigInt(file.size), true);
  view.setBigUint64(head.byteLength + tail.byteLength + 8, BigInt(Math.max(0, Math.trunc(file.lastModified))), true);
  return `sha256:${hex(await crypto.subtle.digest('SHA-256', input))}`;
}
