import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipMetadata } from '@/contracts/posetrack';
import type { RenderPlayer } from '@/contracts/renderer';
import type { FrameSource } from '@/render';
import { useSessionStore } from '../stores/session';
import { useViewStore } from '../stores/view';
import { batchOf, testScene } from '../testing';
import { remapTrackIds } from './remap';

const FRAMES = 40;

function player(trackId: number, box: [number, number, number, number] | null, keypoints: Float32Array | null = null) {
  return { trackId, box, keypoints } as unknown as RenderPlayer;
}

/** People stand at fixed places side by side, all on screen in every frame; `ids[k]` is the id of the person at place k. */
function lineup(ids: readonly (number | null)[], jitter = 0): FrameSource {
  return {
    frameAt: (i: number) =>
      ({
        players: ids.flatMap((id, k) =>
          id === null ? [] : [player(id, [k * 200 + jitter * (i % 3), 100, k * 200 + 120 + jitter * (i % 3), 400])],
        ),
      }) as never,
  };
}

const allFrames = (ids: readonly number[]) => new Map(ids.map((id) => [id, new Uint8Array(FRAMES).fill(4)]));

describe('remapTrackIds', () => {
  it('follows each pick to the same person when the result numbers all players differently', () => {
    const streamed = lineup([1, 2, 3, 4]);
    // same places, ids permuted, boxes moved a little by smoothing
    const result = lineup([3, 1, 4, 2], 4);
    const map = remapTrackIds([1, 2, 3, 4], streamed, result, allFrames([1, 2, 3, 4]));
    expect([...map]).toEqual([
      [1, 3],
      [2, 1],
      [3, 4],
      [4, 2],
    ]);
  });

  it('keeps an id that did not change, however many players are on screen together', () => {
    const same = lineup([1, 2, 3, 4, 5, 6]);
    const map = remapTrackIds([4], same, lineup([1, 2, 3, 4, 5, 6], 3), allFrames([4]));
    expect(map.get(4)).toBe(4);
  });

  it('drops a pick that has no counterpart in the result', () => {
    const streamed = lineup([1, 2, 3, 4, 5]);
    const result = lineup([1, 2, 3, 4, null]);
    const map = remapTrackIds([5, 2], streamed, result, allFrames([5, 2]));
    expect(map.has(5)).toBe(false);
    expect(map.get(2)).toBe(2);
  });

  it('drops a pick without a clear majority', () => {
    // the person is matched to a different result id in each half of the samples
    const streamed = lineup([1, 2]);
    const result: FrameSource = {
      frameAt: (i) => ({ players: [player(i < FRAMES / 2 ? 7 : 8, [0, 100, 120, 400])] }) as never,
    };
    const lane = new Map([[1, new Uint8Array(FRAMES).fill(4)]]);
    // 6 samples vote for 7, 6 for 8: neither wins more than half
    expect(remapTrackIds([1], streamed, result, lane).size).toBe(0);
  });

  it('samples only the frames in which the streamed player was present', () => {
    const streamed = lineup([1, 2]);
    // after frame 10 the result has someone else at that place
    const result: FrameSource = {
      frameAt: (i) => ({ players: [player(i < 10 ? 9 : 5, [0, 100, 120, 400])] }) as never,
    };
    const lane = new Uint8Array(FRAMES);
    lane.fill(4, 0, 10);
    expect(remapTrackIds([1], streamed, result, new Map([[1, lane]])).get(1)).toBe(9);
  });

  it('uses the keypoints when a player has no box', () => {
    const kp = new Float32Array(78).fill(Number.NaN);
    for (let j = 0; j < 4; j++) {
      kp[j * 3] = 10 + j * 30;
      kp[j * 3 + 1] = 100 + j * 90;
      kp[j * 3 + 2] = 0.9;
    }
    const streamed: FrameSource = {
      frameAt: () => ({ players: [player(1, null, kp), player(2, [500, 100, 600, 400])] }) as never,
    };
    const result: FrameSource = {
      frameAt: () => ({ players: [player(8, [500, 100, 600, 400]), player(6, [10, 100, 100, 370])] }) as never,
    };
    expect(remapTrackIds([1], streamed, result, allFrames([1])).get(1)).toBe(6);
  });
});

describe('setFinal follows the picked players', () => {
  const ids = testScene.tracks.map((t) => t.id);
  beforeEach(() => {
    useSessionStore.getState().clear();
    useViewStore.getState().reset();
    useSessionStore.getState().beginClip('c.mp4', {} as ClipMetadata, testScene.frames);
    useSessionStore.getState().addChunks([{ batch: batchOf(0, 24), seq: 0 }]);
  });

  const resultWith = (renumber: (id: number) => number) => ({
    header: {} as never,
    frames: testScene.frames,
    tracks: testScene.tracks.map((t) => ({ ...t, id: renumber(t.id) })),
    ball: testScene.ball,
  });

  it('keeps focus, solo and hidden players when the ids did not change', () => {
    const [a, b, c] = ids as [number, number, number];
    const view = useViewStore.getState();
    view.toggleSolo(b); // solo also focuses that player, so pick the focus after it
    view.setFocus(a);
    view.toggleHidden(c);
    useSessionStore.getState().setFinal(resultWith((id) => id));
    expect(useViewStore.getState()).toMatchObject({ focusTrackId: a, soloTrackId: b, hiddenTrackIds: [c] });
  });

  it('moves them to the same people when the result renumbers its tracks', () => {
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = ids as [number, number, number];
    const view = useViewStore.getState();
    view.toggleSolo(b); // solo also focuses that player, so pick the focus after it
    view.setFocus(a);
    view.toggleHidden(c);
    // a reversed numbering: the person who was `id` is `max + min - id` in the result
    const flip = (id: number) => Math.max(...ids) + Math.min(...ids) - id;
    useSessionStore.getState().setFinal(resultWith(flip));
    expect(useViewStore.getState()).toMatchObject({
      focusTrackId: flip(a),
      soloTrackId: flip(b),
      hiddenTrackIds: [flip(c)],
    });
  });
});
