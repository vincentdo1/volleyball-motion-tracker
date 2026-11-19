import { create } from 'zustand';
import { readJson, removeKey, writeJson } from '@/ui/safe-storage';

const KEY = 'vbt.settings';
const APPEARANCE_KEY = 'vbt.appearance';
const HINTS_KEY = 'vbt.hints';

/** The three coach marks (05 §4.9), each shown once. */
export const HINT_IDS = ['focus-player', 'frame-step', 'export'] as const;
export type HintId = (typeof HINT_IDS)[number];

interface SettingsState {
  /** Opt in to the heavier detector (`webgpu-quality` tier). Takes effect for the next clip. */
  readonly qualityMode: boolean;
  readonly dismissedHints: readonly HintId[];
  setQualityMode(on: boolean): void;
  dismissHint(id: HintId): void;
  /** Puts the quality mode and the dismissed tips back to their defaults and forgets the stored appearance. */
  resetPreferences(): void;
}

function stored(): Pick<SettingsState, 'qualityMode' | 'dismissedHints'> {
  const settings = readJson(KEY);
  const hints = readJson(HINTS_KEY);
  return {
    qualityMode:
      typeof settings === 'object' && settings !== null && (settings as { qualityMode?: unknown }).qualityMode === true,
    dismissedHints: Array.isArray(hints) ? HINT_IDS.filter((id) => hints.includes(id)) : [],
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...stored(),
  setQualityMode(qualityMode) {
    writeJson(KEY, { qualityMode });
    set({ qualityMode });
  },
  dismissHint(id) {
    const dismissedHints = get().dismissedHints.includes(id) ? get().dismissedHints : [...get().dismissedHints, id];
    writeJson(HINTS_KEY, dismissedHints);
    set({ dismissedHints });
  },
  resetPreferences() {
    for (const key of [KEY, HINTS_KEY, APPEARANCE_KEY]) removeKey(key);
    set({ qualityMode: false, dismissedHints: [] });
  },
}));
