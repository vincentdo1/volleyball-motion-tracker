import { create } from 'zustand';
import { readJson, writeJson } from './safe-storage';

export type ThemePreference = 'system' | 'dark' | 'light';
export type MotionPreference = 'system' | 'reduce' | 'full';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'vbt.appearance';

interface Stored {
  theme: ThemePreference;
  motion: MotionPreference;
}

const THEMES: readonly ThemePreference[] = ['system', 'dark', 'light'];
const MOTIONS: readonly MotionPreference[] = ['system', 'reduce', 'full'];

function readStored(): Stored {
  const parsed = readJson(STORAGE_KEY);
  if (typeof parsed === 'object' && parsed !== null) {
    const { theme, motion } = parsed as Record<string, unknown>;
    return {
      theme: THEMES.find((t) => t === theme) ?? 'system',
      motion: MOTIONS.find((m) => m === motion) ?? 'system',
    };
  }
  return { theme: 'system', motion: 'system' };
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function systemPrefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

export function resolveReducedMotion(preference: MotionPreference): boolean {
  return preference === 'system' ? systemPrefersReducedMotion() : preference === 'reduce';
}

interface ThemeState extends Stored {
  resolved: ResolvedTheme;
  reducedMotion: boolean;
  setTheme(theme: ThemePreference): void;
  setMotion(motion: MotionPreference): void;
  /** Re-resolves "system" preferences after the OS setting changed. */
  refresh(): void;
}

/** Writes the resolved preferences to the document so CSS (`data-theme`, `data-motion`) follows. */
export function applyAppearance(state: Pick<ThemeState, 'resolved' | 'reducedMotion'>): void {
  const root = document.documentElement;
  root.dataset.theme = state.resolved;
  root.dataset.motion = state.reducedMotion ? 'reduce' : 'full';
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const stored = readStored();
  return {
    ...stored,
    resolved: resolveTheme(stored.theme),
    reducedMotion: resolveReducedMotion(stored.motion),
    setTheme(theme) {
      writeJson(STORAGE_KEY, { theme, motion: get().motion });
      set({ theme, resolved: resolveTheme(theme) });
    },
    setMotion(motion) {
      writeJson(STORAGE_KEY, { theme: get().theme, motion });
      set({ motion, reducedMotion: resolveReducedMotion(motion) });
    },
    refresh() {
      const { theme, motion } = get();
      set({ resolved: resolveTheme(theme), reducedMotion: resolveReducedMotion(motion) });
    },
  };
});

/** Applies the stored appearance and follows OS changes while the preference is "system". Returns a disposer. */
export function startAppearanceSync(): () => void {
  applyAppearance(useThemeStore.getState());
  const unsubscribe = useThemeStore.subscribe(applyAppearance);
  const queries =
    typeof matchMedia === 'function'
      ? [matchMedia('(prefers-color-scheme: light)'), matchMedia('(prefers-reduced-motion: reduce)')]
      : [];
  const refresh = () => useThemeStore.getState().refresh();
  for (const q of queries) q.addEventListener('change', refresh);
  return () => {
    unsubscribe();
    for (const q of queries) q.removeEventListener('change', refresh);
  };
}
