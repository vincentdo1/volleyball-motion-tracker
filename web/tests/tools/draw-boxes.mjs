/**
 * Draws labelled boxes on a frame of a clip for review.
 *   node tests/tools/draw-boxes.mjs <video> <frameIndex> <boxes.json> <out.png> [--crop x0,y0,x1,y1]
 * boxes.json: [{ box: [x0,y0,x1,y1], label: "3", color: "#ff0" }]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const [video, frame, boxesFile, out, ...rest] = process.argv.slice(2);
const crop = rest[0] === '--crop' ? rest[1].split(',').map(Number) : null;
const boxes = JSON.parse(readFileSync(boxesFile, 'utf8'));
const png = execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-i',
    video,
    '-vf',
    `select=eq(n\\,${frame})`,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    '-',
  ],
  { maxBuffer: 1 << 28 },
);
const meta = await sharp(png).metadata();
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${boxes
  .map(
    (b) =>
      `<rect x="${b.box[0]}" y="${b.box[1]}" width="${b.box[2] - b.box[0]}" height="${b.box[3] - b.box[1]}" fill="none" stroke="${b.color ?? '#ffd400'}" stroke-width="2"/><text x="${b.box[0] + 2}" y="${Math.max(14, b.box[1] - 3)}" font-family="Helvetica" font-size="18" font-weight="bold" fill="${b.color ?? '#ffd400'}" stroke="#000" stroke-width="0.6">${b.label}</text>`,
  )
  .join('')}</svg>`;
let img = sharp(png).composite([{ input: Buffer.from(svg) }]);
if (crop)
  img = sharp(await img.png().toBuffer()).extract({
    left: crop[0],
    top: crop[1],
    width: crop[2] - crop[0],
    height: crop[3] - crop[1],
  });
await img.png().toFile(out);
