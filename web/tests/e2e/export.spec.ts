import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import { type EXPORT_TITLES, exportFile, ffprobe, isPreview, processClip, repoVideo, useRealEngine } from './support';

/**
 * M2/M3: the four exports of the real engine are validated against the ffprobe goldens and the PoseTrack v1 schema.
 * attempt_03 is the edit-list clip (46 pre-roll packets dropped) with audio; beach has 1080p, audio and 11 players.
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview (M2-2)');
test.use({ serviceWorkers: 'block' });
test.setTimeout(300_000);

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js');
const addFormats = require('ajv-formats');

interface Doc {
  frames: { ptsUs: number[] };
  clip: { displayWidth: number; displayHeight: number; frameCount: number };
  coordinateSpace: { width: number; height: number };
  tracks: { samples: { ptsUs: number[]; kp: (number | null)[] } }[];
  ball: { samples: { ptsUs: number[]; visibility: number[] } } | null;
}

for (const clip of ['volleyball_spike_attempt_03.mp4', 'github_beach_st_lenina_20250622_g1_005.mp4']) {
  test.describe(clip, () => {
    const golden = clipGolden(clip);
    let dir = '';
    let doc: Doc;
    const files: Partial<Record<keyof typeof EXPORT_TITLES, string>> = {};

    test.beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'vbt-export-'));
    });

    test('exports JSON, CSV, PNG and MP4 after a real run', async ({ page, context }) => {
      await useRealEngine(context);
      await processClip(page, repoVideo(clip));
      for (const kind of ['json', 'csv', 'png', 'mp4'] as const) files[kind] = await exportFile(page, kind, dir);
      doc = JSON.parse(readFileSync(files.json as string, 'utf8')) as Doc;
    });

    test('JSON keys every sample by the golden frame PTS table', () => {
      expect(doc.frames.ptsUs).toEqual(golden.video.ptsUs);
      expect(doc.clip.frameCount).toBe(golden.video.presentableFrames);
      expect([doc.clip.displayWidth, doc.clip.displayHeight]).toEqual([
        golden.video.displayWidth,
        golden.video.displayHeight,
      ]);
      const known = new Set(golden.video.ptsUs);
      for (const t of doc.tracks) for (const p of t.samples.ptsUs) expect(known.has(p)).toBe(true);
    });

    test('M2-3: JSON validates against posetrack.schema.json (models[].inputSize is [0, 0] for the detector)', () => {
      const schema = JSON.parse(
        readFileSync(join(import.meta.dirname, '../../src/contracts/posetrack.schema.json'), 'utf8'),
      );
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      const validate = ajv.compile(schema);
      expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
    });

    test('CSV has the exact header and one row per visible joint and ball sample', () => {
      const lines = readFileSync(files.csv as string, 'utf8')
        .trimEnd()
        .split('\n');
      expect(lines[0]).toBe(
        'pts_us,time_s,entity,track_id,joint,x_px,y_px,x_norm,y_norm,score,interpolated,low_confidence',
      );
      let rows = 0;
      for (const t of doc.tracks)
        for (let i = 0; i < t.samples.kp.length; i += 3)
          if (t.samples.kp[i] != null && t.samples.kp[i + 1] != null) rows++;
      rows += doc.ball?.samples.visibility.filter((v) => v > 0).length ?? 0;
      expect(lines.length - 1).toBe(rows);
    });

    test('PNG is the display size', () => {
      const png = readFileSync(files.png as string);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        golden.video.displayWidth,
        golden.video.displayHeight,
      ]);
    });

    test('MP4 has the source frame count, PTS list, size and audio within one frame', () => {
      const mp4 = files.mp4 as string;
      const video = ffprobe(['-select_streams', 'v:0', '-show_entries', 'frame=pts_time', mp4]);
      const pts = (video.frames ?? []).map((f) => Math.round(Number(f.pts_time) * 1e6)).sort((a, b) => a - b);
      expect(pts).toHaveLength(golden.video.presentableFrames);
      const worst = pts.reduce((m, p, i) => Math.max(m, Math.abs(p - (golden.video.ptsUs[i] as number))), 0);
      expect(worst, 'max PTS difference in us').toBeLessThanOrEqual(1000);
      const streams =
        ffprobe(['-show_entries', 'stream=codec_type,codec_name,width,height,start_time', mp4]).streams ?? [];
      const v = streams.find((s) => s.codec_type === 'video');
      expect([v?.width, v?.height]).toEqual([golden.video.displayWidth, golden.video.displayHeight]);
      const a = streams.find((s) => s.codec_type === 'audio');
      expect(Boolean(a)).toBe(Boolean(golden.audio));
      if (a && golden.audio) {
        const frameUs = (1e6 * golden.video.nominalFps.den) / golden.video.nominalFps.num;
        expect(Math.abs(Number(a.start_time) * 1e6 - golden.audio.startUs)).toBeLessThanOrEqual(frameUs);
      }
    });
  });
}
