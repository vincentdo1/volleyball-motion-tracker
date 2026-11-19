import { create } from 'zustand';

/** What the engine is doing before it can take a clip: loading its models (a download on a first visit) and warming up. */
export interface EngineStatusState {
  /** The app asked the engine to initialise and it has not answered yet. */
  readonly preparing: boolean;
  /** Bytes of the models downloaded so far and in total, summed over the models the engine reported. */
  readonly bytesDone: number;
  readonly bytesTotal: number;
  /** Some model is being fetched from the network (rather than read from the cache). */
  readonly downloading: boolean;
  /** Share downloaded, 0-100. Never goes back while preparing: models load one after another and the total grows. */
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

export const useEngineStatus = create<EngineStatusState>((set, get) => ({
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
      downloading ||= !m.fromCache;
    }
    const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    set({ bytesDone: done, bytesTotal: total, downloading, percent: Math.max(get().percent, percent) });
  },
  endPreparing: () => set({ preparing: false }),
}));
