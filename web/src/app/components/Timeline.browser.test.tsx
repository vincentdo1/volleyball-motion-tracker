import '../../styles/app.css';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';
import type { PlayerController, PlayerSnapshot } from '../player/controller';
import { type LaneData, LaneLevel } from '../results/lanes';
import type { TrackInfo } from '../results/tracks';
import { irregularPts } from '../testing';
import { Timeline } from './Timeline';

/** A touch device: Chromium then reports a coarse primary pointer (what `hasTouch` does in a Playwright context). */
const setTouch = (enabled: boolean) =>
  (cdp() as unknown as { send(method: string, params: object): Promise<unknown> }).send(
    'Emulation.setTouchEmulationEnabled',
    { enabled, maxTouchPoints: enabled ? 5 : 1 },
  );

afterEach(async () => {
  cleanup();
  await setTouch(false);
});

const SNAPSHOT: PlayerSnapshot = {
  frameIndex: 0,
  timeS: 0,
  playing: false,
  rate: 1,
  loop: false,
  muted: false,
  ended: false,
};

function stubController(frameIndex: number, timeS: number) {
  const snapshot = { ...SNAPSHOT, frameIndex, timeS };
  const seekToIndex = vi.fn();
  const controller = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    seekToIndex,
    scrubToTime: vi.fn(),
    step: vi.fn(),
  } as unknown as PlayerController;
  return { controller, seekToIndex };
}

const track = (id: number): TrackInfo => ({
  id,
  label: `P${id}`,
  colorSlot: id - 1,
  bestLevel: LaneLevel.Full,
  samples: 10,
});

function mount(frameIndex: number, trackCount: number, lanes: LaneData) {
  const ptsUs = irregularPts();
  const { controller, seekToIndex } = stubController(frameIndex, (ptsUs[frameIndex] as number) / 1e6);
  const tracks = Array.from({ length: trackCount }, (_, i) => track(i + 1));
  const view = render(
    <div style={{ width: 640 }}>
      <Timeline
        controller={controller}
        ptsUs={ptsUs}
        durationS={10}
        lanes={lanes}
        revision={1}
        tracks={tracks}
        processedFrames={ptsUs.length}
        focusTrackId={null}
        hiddenTrackIds={[]}
        onFocus={() => undefined}
        onToggleHidden={() => undefined}
      />
    </div>,
  );
  const slider = view.getByRole('slider', { name: 'Timeline' });
  return { slider, seekToIndex, view };
}

/** Whether the lane row `row` has paint in the canvas column at `fraction` of the width. */
function painted(canvas: HTMLCanvasElement, laneH: number, row: number, fraction: number): boolean {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const dpr = canvas.width / canvas.clientWidth;
  const x = Math.floor(fraction * canvas.clientWidth * dpr);
  const y = Math.round((22 + row * laneH + laneH / 2) * dpr);
  return (ctx.getImageData(x, y, 1, 1).data[3] as number) > 0;
}

describe('timeline lanes and playhead in time (F5)', () => {
  // player 1 is seen in the dense first second only; player 2 only in the ten sparse frames after it
  const lanes = (): LaneData => {
    const first = new Uint8Array(110);
    first.fill(LaneLevel.Full, 0, 100);
    const second = new Uint8Array(110);
    second.fill(LaneLevel.Full, 100, 110);
    return {
      players: new Map([
        [1, first],
        [2, second],
      ]),
      ball: new Uint8Array(110),
    };
  };

  it('spreads a dense first second over 10% of the lane and a sparse stretch over the rest', async () => {
    const { slider } = mount(0, 2, lanes());
    const canvas = slider.querySelector('canvas') as HTMLCanvasElement;
    await vi.waitFor(() => expect(painted(canvas, 28, 0, 0.05)).toBe(true));
    // lane 1 stops where its frames stop in time (1 s of 10)
    expect(painted(canvas, 28, 0, 0.09)).toBe(true);
    expect(painted(canvas, 28, 0, 0.15)).toBe(false);
    expect(painted(canvas, 28, 0, 0.6)).toBe(false);
    // lane 2 starts at 1 s and is continuous across the sparse stretch up to the end
    expect(painted(canvas, 28, 1, 0.05)).toBe(false);
    expect(painted(canvas, 28, 1, 0.12)).toBe(true);
    expect(painted(canvas, 28, 1, 0.5)).toBe(true);
    expect(painted(canvas, 28, 1, 0.97)).toBe(true);
  });

  it('puts the playhead where the ruler says and seeks to the frame at the pointer', async () => {
    const { slider, seekToIndex } = mount(100, 2, lanes());
    const rect = slider.getBoundingClientRect();
    // frame 100 is at t = 1 s: 10% of the way along the ruler (10 s), not 91%
    const head = slider.querySelector('div[aria-hidden]') as HTMLElement;
    expect(head.getBoundingClientRect().left).toBeCloseTo(rect.left + 0.1 * rect.width, 0);
    await userEvent.click(slider, { position: { x: 0.5 * rect.width, y: 5 } });
    expect(seekToIndex).toHaveBeenCalledWith(104);
  });
});

describe('timeline rows under a touch pointer (F9)', () => {
  const lanes = (): LaneData => ({
    players: new Map([
      [1, new Uint8Array(110)],
      [2, new Uint8Array(110)],
      [3, new Uint8Array(110)],
    ]),
    ball: new Uint8Array(110),
  });

  const rowsOf = (root: HTMLElement) => {
    const buttons = [...root.querySelectorAll('button')];
    // each row holds a focus button and a hide button, side by side
    const rows: DOMRect[] = [];
    for (let i = 0; i < buttons.length; i += 2) {
      const a = (buttons[i] as HTMLElement).getBoundingClientRect();
      const b = (buttons[i + 1] as HTMLElement).getBoundingClientRect();
      rows.push(
        new DOMRect(
          a.left,
          Math.min(a.top, b.top),
          a.width + b.width,
          Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
        ),
      );
    }
    return rows;
  };

  it('keeps every lane row at least 44 px tall, so neighbouring hit targets never overlap', async () => {
    await setTouch(true);
    await vi.waitFor(() => expect(matchMedia('(pointer: coarse)').matches).toBe(true));
    const { view } = mount(0, 3, lanes());
    const rows = rowsOf(view.container);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.height).toBeGreaterThanOrEqual(44);
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i - 1] as DOMRect).bottom).toBeLessThanOrEqual((rows[i] as DOMRect).top + 0.01);
    }
    // the canvas rows follow: one 44 px lane per player plus the ball, under the ruler
    const slider = view.getByRole('slider', { name: 'Timeline' });
    expect(slider.getBoundingClientRect().height).toBeCloseTo(22 + 4 * 44, 0);
  });

  it('keeps the compact 28 px rows for a mouse', async () => {
    await vi.waitFor(() => expect(matchMedia('(pointer: coarse)').matches).toBe(false));
    const { view } = mount(0, 3, lanes());
    const slider = view.getByRole('slider', { name: 'Timeline' });
    expect(slider.getBoundingClientRect().height).toBeCloseTo(22 + 4 * 28, 0);
  });
});
