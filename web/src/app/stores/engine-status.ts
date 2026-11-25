import { create } from 'zustand';

/** What the engine is doing before it can take a clip: loading its models (a download on a first visit) and warming up. */
export interface EngineStatusState {
  /** The app asked the engine to initialise and it has not answered yet. */
  readonly preparing: boolean;
  /** Bytes of the models downloaded so far and in total, summed over the models the engine reported. */
  readonly bytesDone: number;
  readonly bytesTotal: number;
  /** A model is being fetched from the network and has not finished (afterwards the engine warms up). */
  readonly downloading: boolean;
  /**
   * Share loaded, 0-100, over every model the engine announced before loading (it announces them all first, so the
   * total does not grow as models report).
   */
  readonly percent: number;
  /** The app is about to initialise the engine: forgets the earlier download figures. */
  beginPreparing(): void;
  addModelProgress(modelId: string, bytesDone: number, bytesTotal: number, fromCache: boolean): void;
  /** The engine is ready, or its initialisation failed. */
  endPreparing(): void;
}

interface ModelBytes {
  done: number;
  total: number;
  fromCache: boolean;
}

/** Per model, kept outside the state: only the sums are shown. */
let models = new Map<string, ModelBytes>();

export const useEngineStatus = create<EngineStatusState>((set) => ({
  preparing: false,
  bytesDone: 0,
  bytesTotal: 0,
  downloading: false,
  percent: 0,
  beginPreparing() {
    models = new Map();
    set({ preparing: true, bytesDone: 0, bytesTotal: 0, downloading: false, percent: 0 });
  },
  addModelProgress(modelId, bytesDone, bytesTotal, fromCache) {
    models.set(modelId, { done: bytesDone, total: Math.max(bytesTotal, bytesDone), fromCache });
    let done = 0;
    let total = 0;
    let downloading = false;
    for (const m of models.values()) {
      done += m.done;
      total += m.total;
      downloading ||= !m.fromCache && m.done < m.total;
    }
    const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    set({ bytesDone: done, bytesTotal: total, downloading, percent });
  },
  endPreparing: () => set({ preparing: false }),
}));
