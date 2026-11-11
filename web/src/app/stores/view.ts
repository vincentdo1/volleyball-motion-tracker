import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from '@/contracts/renderer';
import { useThemeStore } from '@/ui/theme';

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
  /** Focus-player layers (they need a focus player). */
  readonly showFocusTrails: boolean;
  readonly showGhosts: boolean;
  readonly showAngles: boolean;
  readonly velocityColor: boolean;
  readonly glow: number;
  readonly panelTab: PanelTab;
  setFocus(trackId: number | null): void;
  /** Forget the picked, hidden and solo players (their ids belong to a stream that was replaced). */
  clearPlayers(): void;
  /** Follow the picks to a result that numbers its players again: an id without an entry is dropped. */
  remapPlayers(map: ReadonlyMap<number, number>): void;
  toggleHidden(trackId: number): void;
  toggleSolo(trackId: number): void;
  setLayer(
    layer: 'showJoints' | 'showChips' | 'showBall' | 'showTrails' | 'showFocusTrails' | 'showGhosts' | 'showAngles',
    on: boolean,
  ): void;
  setVelocityColor(on: boolean): void;
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
  showFocusTrails: true,
  showGhosts: false,
  showAngles: false,
  velocityColor: false,
  glow: DEFAULT_RENDER_OPTIONS.glow,
  panelTab: 'players' as PanelTab,
};

/** How the user wants the overlay drawn: focus, hidden players and layers. Cleared for every new clip. */
export const useViewStore = create<ViewState>((set) => ({
  ...INITIAL,
  setFocus: (focusTrackId) => set((s) => ({ focusTrackId: s.focusTrackId === focusTrackId ? null : focusTrackId })),
  clearPlayers: () => set({ focusTrackId: null, soloTrackId: null, hiddenTrackIds: [] }),
  remapPlayers: (map) =>
    set((s) => ({
      focusTrackId: s.focusTrackId === null ? null : (map.get(s.focusTrackId) ?? null),
      soloTrackId: s.soloTrackId === null ? null : (map.get(s.soloTrackId) ?? null),
      hiddenTrackIds: s.hiddenTrackIds.flatMap((id) => {
        const next = map.get(id);
        return next === undefined ? [] : [next];
      }),
    })),
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
  setVelocityColor: (velocityColor) => set({ velocityColor }),
  setColorMode: (colorMode) => set({ colorMode }),
  setGlow: (glow) => set({ glow }),
  setPanelTab: (panelTab) => set({ panelTab }),
  reset: () => {
    useDrawStatus.setState({ ghostsStill: false });
    set({ ...INITIAL, hiddenTrackIds: [] });
  },
}));

/**
 * What the last drawn frame reports back. Its own small store: it changes from inside the draw loop, and the screens
 * that subscribe to the view store (the player, the timeline, the panels) must not re-render for it.
 */
export const useDrawStatus = create<{ readonly ghostsStill: boolean }>(() => ({ ghostsStill: false }));

/** The last drawn frame skipped the ghosts because the focus player barely moved. */
export function setGhostsStill(still: boolean): void {
  if (useDrawStatus.getState().ghostsStill !== still) useDrawStatus.setState({ ghostsStill: still });
}

/**
 * The renderer's options for the current view. `allTrackIds` lets "solo" hide everyone else; the result is
 * referentially stable until something that affects the picture changes.
 */
export function useRenderOptions(allTrackIds: readonly number[]): RenderOptions {
  const {
    focusTrackId,
    hiddenTrackIds,
    soloTrackId,
    colorMode,
    showJoints,
    showChips,
    showBall,
    showTrails,
    showFocusTrails,
    showGhosts,
    showAngles,
    velocityColor,
    glow,
  } = useViewStore(
    useShallow((s) => ({
      focusTrackId: s.focusTrackId,
      hiddenTrackIds: s.hiddenTrackIds,
      soloTrackId: s.soloTrackId,
      colorMode: s.colorMode,
      showJoints: s.showJoints,
      showChips: s.showChips,
      showBall: s.showBall,
      showTrails: s.showTrails,
      showFocusTrails: s.showFocusTrails,
      showGhosts: s.showGhosts,
      showAngles: s.showAngles,
      velocityColor: s.velocityColor,
      glow: s.glow,
    })),
  );
  const reducedMotion = useThemeStore((s) => s.reducedMotion);
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
      showFocusTrails,
      showGhosts,
      showAngles,
      velocityColor,
      reducedMotion,
      glow,
    }),
    [
      focusTrackId,
      hiddenTrackIds,
      soloTrackId,
      trackIds,
      colorMode,
      showJoints,
      showChips,
      showBall,
      showTrails,
      showFocusTrails,
      showGhosts,
      showAngles,
      velocityColor,
      reducedMotion,
      glow,
    ],
  );
}
