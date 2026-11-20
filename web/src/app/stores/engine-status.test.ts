import { beforeEach, describe, expect, it } from 'vitest';
import { useEngineStatus } from './engine-status';

const MB = 1_000_000;
const status = () => useEngineStatus.getState();

/** What the engine announces before loading: every model of the tier, nothing loaded, not a download yet. */
function announce(): void {
  status().addModelProgress('detector', 0, 40 * MB, true);
  status().addModelProgress('pose', 0, 55 * MB, true);
  status().addModelProgress('ball', 0, 1 * MB, true);
}

beforeEach(() => status().beginPreparing());

describe('model download progress (review N1)', () => {
  it('does not read 100 % when the small model finishes before the large ones report', () => {
    announce();
    status().addModelProgress('ball', MB / 2, MB, false);
    expect(status().downloading).toBe(true);
    status().addModelProgress('ball', MB, MB, false);
    expect(status().percent).toBe(1);
    expect(status().bytesTotal).toBe(96 * MB);
    // the large downloads start and move the share forward from there
    status().addModelProgress('detector', 20 * MB, 40 * MB, false);
    expect(status().downloading).toBe(true);
    expect(status().percent).toBe(21);
  });

  it('counts cached models as loaded and shows a download only while one is unfinished', () => {
    announce();
    status().addModelProgress('detector', 40 * MB, 40 * MB, true);
    status().addModelProgress('ball', MB, MB, true);
    expect(status().downloading).toBe(false);
    status().addModelProgress('pose', 11 * MB, 55 * MB, false);
    expect(status().downloading).toBe(true);
    expect(status().percent).toBe(54);
  });

  it('leaves the download state once every model is in, while the engine warms up', () => {
    announce();
    for (const [id, size] of [
      ['detector', 40 * MB],
      ['pose', 55 * MB],
      ['ball', MB],
    ] as const) {
      status().addModelProgress(id, size, size, false);
    }
    expect(status().percent).toBe(100);
    expect(status().downloading).toBe(false);
    expect(status().preparing).toBe(true);
  });
});
