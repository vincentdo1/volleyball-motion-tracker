import { create } from 'zustand';

export type SheetId = 'export' | 'settings' | 'privacy' | 'shortcuts' | 'panels';

interface UiState {
  readonly open: SheetId | null;
  show(sheet: SheetId): void;
  close(): void;
}

/** Which sheet or dialog is open. One at a time keeps focus handling simple. */
export const useUiStore = create<UiState>((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null }),
}));
