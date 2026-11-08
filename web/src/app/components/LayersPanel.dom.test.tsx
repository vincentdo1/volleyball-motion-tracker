import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useThemeStore } from '@/ui/theme';
import { useRenderOptions, useViewStore } from '../stores/view';
import { LayersPanel } from './LayersPanel';

beforeEach(() => useViewStore.getState().reset());
afterEach(cleanup);

describe('LayersPanel focus layers', () => {
  it('starts with trails on and ghosts, angles and speed colours off', () => {
    render(<LayersPanel />);
    expect(screen.getByRole('button', { name: 'Hand trails' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Ghosts' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Angles' }).getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByRole('radio', { name: 'By speed' }) as HTMLInputElement).checked).toBe(false);
  });

  it('tells the user these need a picked player', () => {
    render(<LayersPanel />);
    expect(screen.getByTestId('focus-layers-note').textContent).toMatch(/Pick a player/);
    act(() => useViewStore.getState().setFocus(3));
    expect(screen.getByTestId('focus-layers-note').textContent).toMatch(/player you picked/);
  });

  it('says why ghosts are missing when the player stands still', () => {
    render(<LayersPanel />);
    act(() => {
      const s = useViewStore.getState();
      s.setFocus(3);
      s.setLayer('showGhosts', true);
      s.setGhostsStill(true);
    });
    expect(screen.getByTestId('focus-layers-note').textContent).toMatch(/Ghosts need the player to move/);
  });

  it('turns the layers and the speed colours into renderer options', () => {
    render(<LayersPanel />);
    const options = renderHook(() => useRenderOptions([1, 2]));
    expect(options.result.current).toMatchObject({ showFocusTrails: true, showGhosts: false, velocityColor: false });
    fireEvent.click(screen.getByRole('button', { name: 'Ghosts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Angles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hand trails' }));
    fireEvent.click(screen.getByRole('radio', { name: 'By speed' }));
    expect(options.result.current).toMatchObject({
      showFocusTrails: false,
      showGhosts: true,
      showAngles: true,
      velocityColor: true,
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Left / right' }));
    expect(options.result.current).toMatchObject({ velocityColor: false, colorMode: 'side' });
  });

  it('passes reduced motion on to the renderer', () => {
    const options = renderHook(() => useRenderOptions([]));
    expect(options.result.current.reducedMotion).toBe(useThemeStore.getState().reducedMotion);
    act(() => useThemeStore.setState({ reducedMotion: true }));
    expect(options.result.current.reducedMotion).toBe(true);
    act(() => useThemeStore.setState({ reducedMotion: false }));
  });
});
