import { HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { PackedFrameBatch } from '@/contracts/posetrack';
import { validatePackedFrameBatch } from '@/contracts/posetrack-codec';

/**
 * On-disk layout of a raw chunk: a sequence of records, one per streamed batch. A record is a 16-byte header
 * (magic, version, frame count, person count) followed by the batch arrays in `PackedFrameBatch` order, each padded
 * to 8 bytes so decoding can build aligned views without copies. Little-endian (every browser target is).
 */
const MAGIC = 0x42544256;
const VERSION = 1;
const HEADER_BYTES = 16;

type ArrayCtor =
  | Float64ArrayConstructor
  | Float32ArrayConstructor
  | Uint32ArrayConstructor
  | Int32ArrayConstructor
  | Uint8ArrayConstructor;

interface Field {
  readonly name: keyof Omit<PackedFrameBatch, 'stage' | 'count'>;
  readonly ctor: ArrayCtor;
  readonly length: (count: number, people: number) => number;
}

const FIELDS: readonly Field[] = [
  { name: 'ptsUs', ctor: Float64Array, length: (n) => n },
  { name: 'durationUs', ctor: Float64Array, length: (n) => n },
  { name: 'frameFlags', ctor: Uint8Array, length: (n) => n },
  { name: 'personOffsets', ctor: Uint32Array, length: (n) => n + 1 },
  { name: 'trackIds', ctor: Int32Array, length: (_, p) => p },
  { name: 'boxes', ctor: Float32Array, length: (_, p) => p * 4 },
  { name: 'boxScores', ctor: Float32Array, length: (_, p) => p },
  { name: 'keypoints', ctor: Float32Array, length: (_, p) => p * PERSON_KP_VALUES },
  { name: 'kpFlags', ctor: Uint8Array, length: (_, p) => p * HALPE26_NUM_KEYPOINTS },
  { name: 'sampleFlags', ctor: Uint8Array, length: (_, p) => p },
  { name: 'ball', ctor: Float32Array, length: (n) => n * 4 },
  { name: 'ballVisibility', ctor: Uint8Array, length: (n) => n },
  { name: 'ballSource', ctor: Uint8Array, length: (n) => n },
];

const pad8 = (bytes: number) => (bytes + 7) & ~7;

function recordBytes(count: number, people: number): number {
  return FIELDS.reduce((sum, f) => sum + pad8(f.length(count, people) * f.ctor.BYTES_PER_ELEMENT), HEADER_BYTES);
}

export function encodeBatch(batch: PackedFrameBatch): Uint8Array {
  const people = batch.personOffsets[batch.count] ?? 0;
  const out = new Uint8Array(recordBytes(batch.count, people));
  const header = new Uint32Array(out.buffer, 0, 4);
  header.set([MAGIC, VERSION, batch.count, people]);
  let offset = HEADER_BYTES;
  for (const field of FIELDS) {
    const source = batch[field.name];
    out.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), offset);
    offset += pad8(source.byteLength);
  }
  return out;
}

/** Decodes every record of a chunk file; throws on a truncated or foreign file. */
export function decodeBatches(bytes: Uint8Array): PackedFrameBatch[] {
  const aligned = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  const buffer = aligned.buffer as ArrayBuffer;
  const batches: PackedFrameBatch[] = [];
  let at = aligned.byteOffset;
  const end = aligned.byteOffset + aligned.byteLength;
  while (at < end) {
    if (end - at < HEADER_BYTES) throw new Error('truncated chunk header');
    const [magic, version, count, people] = new Uint32Array(buffer, at, 4) as unknown as [
      number,
      number,
      number,
      number,
    ];
    if (magic !== MAGIC || version !== VERSION) throw new Error('not a raw chunk record');
    const size = recordBytes(count, people);
    if (at + size > end) throw new Error('truncated chunk record');
    const fields: Record<string, ArrayLike<number>> = {};
    let offset = at + HEADER_BYTES;
    for (const field of FIELDS) {
      const length = field.length(count, people);
      fields[field.name] = new field.ctor(buffer, offset, length);
      offset += pad8(length * field.ctor.BYTES_PER_ELEMENT);
    }
    const batch = { stage: 'raw', count, ...fields } as unknown as PackedFrameBatch;
    const problems = validatePackedFrameBatch(batch);
    if (problems.length > 0) throw new Error(`corrupt chunk record: ${problems[0]}`);
    batches.push(batch);
    at += size;
  }
  return batches;
}

/**
 * A batch whose arrays own their memory. Decoded batches are views on the one buffer of their chunk file; posting
 * one with a transfer list would detach that buffer under every other batch (and under the store's own copy).
 */
export function detachedCopy(batch: PackedFrameBatch): PackedFrameBatch {
  const copy: Record<string, unknown> = { stage: batch.stage, count: batch.count };
  for (const field of FIELDS) copy[field.name] = batch[field.name].slice();
  return copy as unknown as PackedFrameBatch;
}
