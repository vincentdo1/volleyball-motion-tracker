import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { isStrictlyIncreasing } from '@/contracts/frame-table';
import { fixtureFile } from '../testing/stub-engine';
import { readTopLevelBoxes } from './mp4-boxes';
import { openClip } from './open-clip';

/** ffprobe truth for the repository clips (frame count, first PTS in us, display size). */
const CLIPS = {
  'github_beach_st_lenina_20250622_g1_005.mp4': [180, 0, 1920, 1080],
  'github_gtu_20250316_002_volleyball_tracking.mp4': [991, 0, 1920, 1080],
  'github_reel_g_volleyball_tracking.mp4': [234, 0, 606, 1080],
  'pexels_single_spiker_6217330.mp4': [230, 0, 1080, 1920],
  'pexels_single_spiker_6217334.mp4': [227, 0, 1080, 1920],
  'pexels_single_spiker_6217335.mp4': [390, 0, 1080, 1920],
  'pexels_single_spiker_6217340.mp4': [315, 0, 1080, 1920],
  'pexels_single_spiker_6217344.mp4': [291, 0, 1080, 1920],
  'volleyball_spike_attempt_02.mp4': [266, 0, 720, 1280],
  'volleyball_spike_attempt_03.mp4': [241, 0, 1280, 720],
  'volleyball_spike_attempt_04.mp4': [181, 0, 1280, 720],
} as const;

/** The tester's ffprobe goldens, when `web/tests/fixtures/clips.json` is present (it lands with the tester's branch). */
interface ClipGolden {
  readonly video: {
    readonly presentableFrames: number;
    readonly firstPtsUs: number;
    readonly ptsUs: number[];
    readonly rotation: number;
  };
}
const testerGoldens = Object.values(
  import.meta.glob<{ clips: Record<string, ClipGolden> }>('../../../tests/fixtures/clips.json', {
    eager: true,
    import: 'default',
  }),
)[0]?.clips;

describe('openClip on the repository clips', () => {
  for (const [name, [frames, firstPts, width, height]] of Object.entries(CLIPS)) {
    it(`${name}: ${frames} presentable frames from PTS ${firstPts}`, async () => {
      const clip = await openClip(await fixtureFile(name));
      try {
        const { metadata, frameTable } = clip;
        expect(metadata.frameCount).toBe(frames);
        expect(frameTable.ptsUs.length).toBe(frames);
        expect(metadata.firstPtsUs).toBe(firstPts);
        expect(isStrictlyIncreasing(frameTable.ptsUs)).toBe(true);
        expect(frameTable.ptsUs.every((pts) => Number.isInteger(pts) && pts >= 0)).toBe(true);
        expect(frameTable.durationUs.every((d) => d > 0)).toBe(true);
        expect([metadata.displayWidth, metadata.displayHeight]).toEqual([width, height]);
        expect(metadata.rotation).toBe(0);
        expect(metadata.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(metadata.variableFrameRate).toBe(false);
        expect(metadata.nominalFps).toBeGreaterThan(29.9);
        expect(metadata.nominalFps).toBeLessThan(30.1);
        expect(metadata.container).toBeTruthy();
        expect(metadata.videoCodec).toMatch(/^avc1\./);
        const golden = testerGoldens?.[name]?.video;
        if (golden) {
          expect(metadata.frameCount).toBe(golden.presentableFrames);
          expect(Array.from(frameTable.ptsUs)).toEqual(golden.ptsUs);
        }
      } finally {
        clip.dispose();
      }
    });
  }

  it('decodes samples whose timestamps equal the frame table, including edit-list clips', async () => {
    for (const name of ['volleyball_spike_attempt_03.mp4', 'volleyball_spike_attempt_04.mp4']) {
      const clip = await openClip(await fixtureFile(name));
      const seen: number[] = [];
      for await (const sample of clip.samples()) {
        if (sample.timestamp >= 0) seen.push(Math.round(sample.timestamp * 1e6));
        sample.close();
      }
      expect(seen).toEqual(Array.from(clip.frameTable.ptsUs));
      clip.dispose();
    }
  });

  it('starts at the frame presented at the requested time (resume seek)', async () => {
    const clip = await openClip(await fixtureFile('volleyball_spike_attempt_04.mp4'));
    const target = clip.frameTable.ptsUs[90] as number;
    const first: number[] = [];
    for await (const sample of clip.samples(target)) {
      first.push(Math.round(sample.timestamp * 1e6));
      sample.close();
      if (first.length === 3) break;
    }
    expect(first).toEqual(Array.from(clip.frameTable.ptsUs.subarray(90, 93)));
    clip.dispose();
  });
});

describe('openClip errors', () => {
  it('rejects a file that is not a video container as unsupported-container', async () => {
    const file = new File([new Uint8Array(4096).fill(7)], 'noise.mp4', { type: 'video/mp4' });
    await expect(openClip(file)).rejects.toMatchObject({
      code: 'unsupported-container',
      action: 'choose-another-file',
    });
  });

  it('rejects a container without video as no-video-track', async () => {
    const audioOnly = new File([wavFile()], 'tone.wav', { type: 'audio/wav' });
    await expect(openClip(audioOnly)).rejects.toMatchObject({ code: 'no-video-track' });
  });

  it('rejects a truncated file as corrupt-file or unsupported-container', async () => {
    const whole = await fixtureFile('volleyball_spike_attempt_04.mp4');
    const cut = new File([whole.slice(0, 5000)], 'cut.mp4', { type: 'video/mp4' });
    await expect(openClip(cut)).rejects.toMatchObject({ recoverable: false });
  });

  it('reports an MP4 whose moov box is missing as damaged or incomplete, not as having no video track (M2-6)', async () => {
    const whole = await fixtureFile('volleyball_spike_attempt_04.mp4');
    const boxes = await readTopLevelBoxes(whole);
    expect(boxes.map((b) => b.type)).toContain('moov');
    const noMoov = boxes.filter((b) => b.type !== 'moov').map((b) => whole.slice(b.offset, b.offset + b.size));
    const error = await openClip(new File(noMoov, 'no-moov.mp4', { type: 'video/mp4' })).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'corrupt-file', action: 'choose-another-file' });
    expect((error as Error).message).toMatch(/damaged or incomplete/);
  });
});

describe('rotation metadata', () => {
  it('reports the display size after the container rotation', async () => {
    const canvas = new OffscreenCanvas(320, 180);
    const ctx = canvas.getContext('2d');
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec: 'avc', bitrate: 1_000_000 });
    output.addVideoTrack(source, { rotation: 90, frameRate: 30 });
    await output.start();
    for (let i = 0; i < 12; i++) {
      ctx?.fillRect(i * 10, 0, 20, 20);
      await source.add(i / 30, 1 / 30);
    }
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('no output');
    const clip = await openClip(new File([buffer], 'rotated.mp4', { type: 'video/mp4' }));
    expect(clip.metadata.rotation).toBe(90);
    expect([clip.metadata.codedWidth, clip.metadata.codedHeight]).toEqual([320, 180]);
    expect([clip.metadata.displayWidth, clip.metadata.displayHeight]).toEqual([180, 320]);
    expect(clip.metadata.frameCount).toBe(12);
    clip.dispose();
  });
});

function wavFile(): ArrayBuffer {
  const samples = 800;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return buffer;
}
