import Ajv2020 from 'ajv/dist/2020';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { afterEach, describe, expect, it } from 'vitest';
import type { PoseTrackDocument } from '@/contracts/posetrack';
import schema from '@/contracts/posetrack.schema.json';
import { validatePoseTrackSemantics } from '@/contracts/posetrack-codec';
import type { EngineEventOf, ExportRequest } from '@/contracts/protocol';
import { DEFAULT_RENDER_OPTIONS } from '@/contracts/renderer';
import type { EngineHandle } from '../client';
import { openClip } from '../ingest/open-clip';
import { createStubEngine, fixtureFile } from '../testing/stub-engine';
import { CSV_HEADER } from './csv';

const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
let engine: EngineHandle | undefined;

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
});

async function processed(clip: string): Promise<EngineHandle> {
  const api = createStubEngine();
  engine = api;
  await api.init({ tierOverride: 'webgpu-default' });
  await api.open(await fixtureFile(clip));
  const done = new Promise<void>((resolve) => api.on('state', (e) => e.state === 'done' && resolve()));
  await api.start();
  await done;
  return api;
}

const mp4: Extract<ExportRequest, { kind: 'mp4' }> = {
  kind: 'mp4',
  overlay: DEFAULT_RENDER_OPTIONS,
  includeAudio: true,
};

describe('JSON and CSV export', () => {
  it('exports a schema-valid PoseTrack document', async () => {
    const api = await processed('volleyball_spike_attempt_04.mp4');
    const exported = await api.exportResult({ kind: 'json' });
    expect(exported.fileName).toBe('volleyball_spike_attempt_04.posetrack.json');
    expect(exported.mimeType).toBe('application/json');
    const doc = JSON.parse(await exported.blob.text()) as PoseTrackDocument;
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(validatePoseTrackSemantics(doc)).toEqual([]);
    expect(doc.clip.frameCount).toBe(181);
    expect(doc.tracks.length).toBe(4);
    expect(doc.frames.ptsUs.length).toBe(181);
    expect(doc.models.length).toBe(3);
    expect(doc.processing.frameStride).toBe(1);
  });

  it('exports CSV with the plan header and one row per visible joint and ball sample', async () => {
    const api = await processed('volleyball_spike_attempt_04.mp4');
    const exported = await api.exportResult({ kind: 'csv' });
    const lines = (await exported.blob.text()).trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.length - 1).toBe(181 * 4 * 26 + 181);
    expect(lines[1]?.split(',')[2]).toBe('person');
    expect(lines.at(-1)?.split(',')[2]).toBe('ball');
  });

  it('refuses to export before a result exists', async () => {
    engine = createStubEngine();
    await engine.init({ tierOverride: 'webgpu-default' });
    await expect(engine.exportResult({ kind: 'json' })).rejects.toMatchObject({ code: 'invalid-state' });
  });
});

async function packetTimes(blob: Blob, kind: 'video' | 'audio'): Promise<number[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
  const times: number[] = [];
  if (track) {
    for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true }))
      times.push(p.timestamp);
  }
  input.dispose();
  return times;
}

describe('MP4 export', () => {
  for (const name of ['volleyball_spike_attempt_04.mp4', 'volleyball_spike_attempt_03.mp4']) {
    it(`${name}: keeps every presentable frame at its original timestamp, with audio`, async () => {
      const api = await processed(name);
      const progress: EngineEventOf<'export-progress'>[] = [];
      api.on('export-progress', (e) => progress.push(e));
      const exported = await api.exportResult(mp4);
      expect(exported.mimeType).toBe('video/mp4');
      const source = await openClip(await fixtureFile(name));
      const out = await openClip(new File([exported.blob], 'out.mp4', { type: 'video/mp4' }));
      expect(out.metadata.frameCount).toBe(source.metadata.frameCount);
      const original = Array.from(source.frameTable.ptsUs);
      const written = Array.from(out.frameTable.ptsUs);
      const worst = Math.max(...original.map((pts, i) => Math.abs(pts - (written[i] ?? Number.POSITIVE_INFINITY))));
      expect(worst).toBeLessThanOrEqual(1);
      expect([out.metadata.displayWidth, out.metadata.displayHeight]).toEqual([
        source.metadata.displayWidth,
        source.metadata.displayHeight,
      ]);
      expect(out.metadata.videoCodec).toMatch(/^avc1\.6400/);
      expect(out.metadata.audioCodec).toBeTruthy();
      // Audio before PTS 0 is dropped together with the unpresentable video frames, so the tracks stay in sync.
      const sourceAudio = (await packetTimes(await fixtureFile(name), 'audio')).filter((t) => t >= 0);
      expect((await packetTimes(exported.blob, 'audio')).length).toBe(sourceAudio.length);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((e) => e.progress.stage === 'export')).toBe(true);
      source.dispose();
      out.dispose();
    }, 60_000);
  }

  it('omits the audio track when asked and downscales when maxHeight is lower', async () => {
    const api = await processed('volleyball_spike_attempt_04.mp4');
    const exported = await api.exportResult({ ...mp4, includeAudio: false, maxHeight: 360 });
    const out = await openClip(new File([exported.blob], 'out.mp4', { type: 'video/mp4' }));
    expect(out.metadata.audioCodec).toBeNull();
    expect([out.metadata.displayWidth, out.metadata.displayHeight]).toEqual([640, 360]);
    expect(out.metadata.frameCount).toBe(181);
    out.dispose();
  }, 60_000);

  it('restricts the export to a time range', async () => {
    const api = await processed('volleyball_spike_attempt_04.mp4');
    const exported = await api.exportResult({ ...mp4, rangeUs: [1_000_000, 2_000_000] });
    const out = await openClip(new File([exported.blob], 'out.mp4', { type: 'video/mp4' }));
    expect(out.metadata.frameCount).toBe(30);
    expect(out.metadata.firstPtsUs).toBeGreaterThanOrEqual(1_000_000 - 1);
    out.dispose();
  }, 60_000);

  it('can be cancelled without disturbing the engine', async () => {
    const api = await processed('github_gtu_20250316_002_volleyball_tracking.mp4');
    const controller = new AbortController();
    const errors: EngineEventOf<'error'>[] = [];
    api.on('error', (e) => errors.push(e));
    const pending = api.exportResult(mp4, { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toMatchObject({ code: 'export-failed', detail: { cancelled: true } });
    expect(api.state).toBe('done');
    expect(errors.length).toBe(0);
    const json = await api.exportResult({ kind: 'json' });
    expect(json.blob.size).toBeGreaterThan(1000);
  }, 60_000);
});

describe('exporting a kept partial result (M2-4)', () => {
  async function cancelled(clip: string): Promise<{ api: EngineHandle; analysed: number }> {
    const api = createStubEngine({ ml: { delayMs: 8 } });
    engine = api;
    const chunks: EngineEventOf<'chunk'>[] = [];
    api.on('chunk', (e) => chunks.push(e));
    await api.init({ tierOverride: 'webgpu-default' });
    await api.open(await fixtureFile(clip));
    await api.start();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await api.cancel();
    return { api, analysed: chunks.reduce((n, c) => n + c.batch.count, 0) };
  }

  it('exports schema-valid JSON marked partial, and CSV, from the frames analysed so far', async () => {
    const { api, analysed } = await cancelled('volleyball_spike_attempt_04.mp4');
    expect(api.state).toBe('opened');
    const json = await api.exportResult({ kind: 'json' });
    const doc = JSON.parse(await json.blob.text()) as PoseTrackDocument;
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(validatePoseTrackSemantics(doc)).toEqual([]);
    const partial = doc.extensions?.partial as { analysedFrames: number; plannedFrames: number };
    expect(partial.plannedFrames).toBe(181);
    expect(partial.analysedFrames).toBeGreaterThan(0);
    expect(partial.analysedFrames).toBeLessThan(181);
    expect(partial.analysedFrames).toBeLessThanOrEqual(analysed);
    expect(doc.frames.ptsUs.length).toBe(181);
    const processed = doc.frames.flags.filter((f) => (f & 1) !== 0).length;
    expect(processed).toBe(partial.analysedFrames);
    const csv = (await (await api.exportResult({ kind: 'csv' })).blob.text()).trimEnd().split('\n');
    expect(csv.length - 1).toBe(processed * 4 * 26 + processed);
  }, 60_000);

  it('exports the overlay video of a partial result', async () => {
    const { api } = await cancelled('volleyball_spike_attempt_04.mp4');
    const exported = await api.exportResult(mp4);
    const out = await openClip(new File([exported.blob], 'out.mp4', { type: 'video/mp4' }));
    expect(out.metadata.frameCount).toBe(181);
    out.dispose();
  }, 60_000);

  it('hands the app the result the exports are made from: same track ids and colour slots, built once', async () => {
    const { api } = await cancelled('volleyball_spike_attempt_04.mp4');
    const finals: EngineEventOf<'final'>[] = [];
    api.on('final', (e) => finals.push(e));
    const result = await api.partialResult();
    expect(result).not.toBeNull();
    expect(finals.map((f) => f.result)).toEqual([result]);
    expect(result?.header.extensions?.partial).toBeDefined();
    const doc = JSON.parse(await (await api.exportResult({ kind: 'json' })).blob.text()) as PoseTrackDocument;
    expect(doc.tracks.map((t) => [t.id, t.colorSlot])).toEqual(result?.tracks.map((t) => [t.id, t.colorSlot]));
    const again = await api.partialResult();
    expect(again?.tracks.map((t) => [t.id, t.colorSlot])).toEqual(result?.tracks.map((t) => [t.id, t.colorSlot]));
    expect(Array.from(again?.frames.ptsUs ?? [])).toEqual(Array.from(result?.frames.ptsUs ?? []));
    // The CSV rows carry the track ids of the result the app shows.
    const csv = (await (await api.exportResult({ kind: 'csv' })).blob.text()).trimEnd().split('\n');
    const csvIds = new Set(
      csv
        .slice(1)
        .filter((l) => l.split(',')[2] === 'person')
        .map((l) => Number(l.split(',')[3])),
    );
    expect([...csvIds].sort()).toEqual((result?.tracks ?? []).map((t) => t.id).sort());
  }, 60_000);

  it('has no partial result when nothing was analysed, or after another clip was opened', async () => {
    const api = createStubEngine({ ml: { delayMs: 300 } });
    engine = api;
    await api.init({ tierOverride: 'webgpu-default' });
    await api.open(await fixtureFile('volleyball_spike_attempt_04.mp4'));
    await api.start();
    await api.cancel();
    expect(await api.partialResult()).toBeNull();
    const { api: second } = await cancelled('volleyball_spike_attempt_04.mp4');
    expect(await second.partialResult()).not.toBeNull();
    await second.open(await fixtureFile('volleyball_spike_attempt_03.mp4'));
    expect(await second.partialResult()).toBeNull();
  }, 60_000);

  it('refuses to export when nothing was analysed, and does not export another clip after a new open', async () => {
    const api = createStubEngine();
    engine = api;
    await api.init({ tierOverride: 'webgpu-default' });
    await api.open(await fixtureFile('volleyball_spike_attempt_04.mp4'));
    await expect(api.exportResult({ kind: 'json' })).rejects.toMatchObject({ code: 'invalid-state' });
    const done = new Promise<void>((resolve) => api.on('state', (e) => e.state === 'done' && resolve()));
    await api.start();
    await done;
    await api.open(await fixtureFile('volleyball_spike_attempt_03.mp4'));
    await expect(api.exportResult({ kind: 'json' })).rejects.toMatchObject({ code: 'invalid-state' });
  }, 60_000);
});
