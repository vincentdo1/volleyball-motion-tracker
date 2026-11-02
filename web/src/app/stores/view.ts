import { useMemo } from 'react';
import { create } from 'zustand';
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from '@/contracts/renderer';

export type PanelTab = 'players' | 'layers' | 'data';

export interface ViewState {
  readonly focusTrackId: number | null;
  readonly hiddenTrackIds: readonly number[];
  readonly soloTrackId: number | null;
  readonly colorMode: RenderOptions['colorMode'];
  readonly showJoints: boolean;
  readonly showChips: boolean;
  readonly showBall: boolean;
  readonly showTrails: boolean;
  readonly glow: number;
  readonly panelTab: PanelTab;
  setFocus(trackId: number | null): void;
  toggleHidden(trackId: number): void;
  toggleSolo(trackId: number): void;
  setLayer(layer: 'showJoints' | 'showChips' | 'showBall' | 'showTrails', on: boolean): void;
  setColorMode(mode: RenderOptions['colorMode']): void;
  setGlow(glow: number): void;
  setPanelTab(tab: PanelTab): void;
  reset(): void;
}

const INITIAL = {
  focusTrackId: null,
  hiddenTrackIds: [] as number[],
  soloTrackId: null,
  colorMode: DEFAULT_RENDER_OPTIONS.colorMode,
  showJoints: DEFAULT_RENDER_OPTIONS.showJoints,
  showChips: DEFAULT_RENDER_OPTIONS.showChips,
  showBall: DEFAULT_RENDER_OPTIONS.showBall,
  showTrails: DEFAULT_RENDER_OPTIONS.showTrails,
  glow: DEFAULT_RENDER_OPTIONS.glow,
  panelTab: 'players' as PanelTab,
};

/** How the user wants the overlay drawn: focus, hidden players and layers. Cleared for every new clip. */
export const useViewStore = create<ViewState>((set) => ({
  ...INITIAL,
  setFocus: (focusTrackId) => set((s) => ({ focusTrackId: s.focusTrackId === focusTrackId ? null : focusTrackId })),
  toggleHidden: (id) =>
    set((s) => ({
      hiddenTrackIds: s.hiddenTrackIds.includes(id)
        ? s.hiddenTrackIds.filter((t) => t !== id)
        : [...s.hiddenTrackIds, id],
      focusTrackId: s.focusTrackId === id && !s.hiddenTrackIds.includes(id) ? null : s.focusTrackId,
    })),
  toggleSolo: (id) =>
    set((s) => ({
      soloTrackId: s.soloTrackId === id ? null : id,
      focusTrackId: s.soloTrackId === id ? s.focusTrackId : id,
    })),
  setLayer: (layer, on) => set({ [layer]: on }),
  setColorMode: (colorMode) => set({ colorMode }),
  setGlow: (glow) => set({ glow }),
  setPanelTab: (panelTab) => set({ panelTab }),
  reset: () => set({ ...INITIAL, hiddenTrackIds: [] }),
}));

/**
 * The renderer's options for the current view. `allTrackIds` lets "solo" hide everyone else; the result is
 * referentially stable until something that affects the picture changes.
 */
export function useRenderOptions(allTrackIds: readonly number[]): RenderOptions {
  const { focusTrackId, hiddenTrackIds, soloTrackId, colorMode, showJoints, showChips, showBall, showTrails, glow } =
    useViewStore();
  // keyed by the ids themselves: a fresh array with the same ids must not rebuild the options
  const idKey = allTrackIds.join(',');
  const trackIds = useMemo(() => (idKey === '' ? [] : idKey.split(',').map(Number)), [idKey]);
  return useMemo(
    () => ({
      ...DEFAULT_RENDER_OPTIONS,
      focusTrackId,
      hiddenTrackIds: soloTrackId === null ? hiddenTrackIds : trackIds.filter((id) => id !== soloTrackId),
      colorMode,
      showJoints,
      showChips,
      showBall,
      showTrails,
      glow,
    }),
    [focusTrackId, hiddenTrackIds, soloTrackId, trackIds, colorMode, showJoints, showChips, showBall, showTrails, glow],
  );
}
