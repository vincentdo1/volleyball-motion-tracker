export interface Mp4Box {
  readonly type: string;
  readonly offset: number;
  /** Bytes the box claims; may reach past the end of a truncated file. */
  readonly size: number;
}

const HEADER_BYTES = 16;

/** Top-level boxes of an ISO-BMFF (MP4, MOV) file, found by hopping header to header without reading media data. */
export async function readTopLevelBoxes(file: Blob): Promise<Mp4Box[]> {
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset + 8 <= file.size) {
    const view = new DataView(await file.slice(offset, offset + HEADER_BYTES).arrayBuffer());
    const type = String.fromCharCode(...new Uint8Array(view.buffer, 4, 4));
    let size = view.getUint32(0);
    if (size === 1 && view.byteLength >= HEADER_BYTES) size = Number(view.getBigUint64(8));
    else if (size === 0) size = file.size - offset;
    if (size < 8 || !/^[\x20-\x7e]{4}$/.test(type)) break;
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

/** True for an MP4/MOV file that holds media data but no `moov` index: a recording or copy that was cut short. */
export async function isMissingMoov(file: Blob): Promise<boolean> {
  const types = (await readTopLevelBoxes(file)).map((box) => box.type);
  return types.includes('ftyp') && types.includes('mdat') && !types.includes('moov');
}
