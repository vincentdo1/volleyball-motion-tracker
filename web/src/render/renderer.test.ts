import { describe, expect, it } from 'vitest';
import { type Canvas2DContext, containTransform, DEFAULT_RENDER_OPTIONS } from '@/contracts/renderer';
import { createFrameSource } from './frame-source';
import { createSkeletonRenderer } from './index';
import { syntheticScene } from './synthetic';

/** A context that records nothing: proves the renderer needs no DOM global (it runs in the export worker). */
function nullContext(): Canvas2DContext {
  const noop = () => undefined;
  return new Proxy({} as Canvas2DContext, {
    get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 12 }) : noop),
    set: () => true,
  });
}

describe('createSkeletonRenderer', () => {
  const scene = syntheticScene({ width: 1920, height: 1080, fps: 30, frameCount: 30, players: 6 });
  const source = createFrameSource(scene);
  const view = containTransform(1920, 1080, 960, 540, 2);

  it('draws without any DOM global and reports what it drew', () => {
    expect(typeof document).toBe('undefined');
    const renderer = createSkeletonRenderer();
    const stats = renderer.draw(nullContext(), source.frameAt(3), view, DEFAULT_RENDER_OPTIONS);
    expect(stats.players).toBe(6);
    expect(stats.levels.full).toBe(6);
    expect(stats.drawMs).toBeGreaterThanOrEqual(0);
    renderer.dispose();
  });

  it('skips hidden players and reports them', () => {
    const stats = createSkeletonRenderer().draw(nullContext(), source.frameAt(3), view, {
      ...DEFAULT_RENDER_OPTIONS,
      hiddenTrackIds: [1, 2],
    });
    expect(stats.levels).toMatchObject({ full: 4, hidden: 2 });
  });

  it('is deterministic: the same inputs give the same draw-call sequence', () => {
    const record = (): string[] => {
      const calls: string[] = [];
      const ctx = new Proxy({} as Canvas2DContext, {
        get: (_t, prop) =>
          prop === 'measureText'
            ? () => ({ width: 12 })
            : (...args: unknown[]) => calls.push(`${String(prop)}(${args.join(',')})`),
        set: (_t, prop, value) => {
          calls.push(`${String(prop)}=${String(value)}`);
          return true;
        },
      });
      createSkeletonRenderer().draw(ctx, source.frameAt(7), view, { ...DEFAULT_RENDER_OPTIONS, focusTrackId: 1 });
      return calls;
    };
    expect(record()).toEqual(record());
  });
});
