import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAppearance, resolveReducedMotion, resolveTheme, useThemeStore } from './theme';

beforeEach(() => {
  localStorage.clear();
  useThemeStore.setState({ theme: 'system', motion: 'system', resolved: 'dark', reducedMotion: false });
});
afterEach(() => localStorage.clear());

describe('theme', () => {
  it('resolves explicit preferences without consulting the OS', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveReducedMotion('reduce')).toBe(true);
    expect(resolveReducedMotion('full')).toBe(false);
  });

  it('persists the choice and mirrors it to the document', () => {
    useThemeStore.getState().setTheme('light');
    useThemeStore.getState().setMotion('reduce');
    expect(JSON.parse(localStorage.getItem('vbt.appearance') ?? '{}')).toEqual({ theme: 'light', motion: 'reduce' });
    applyAppearance(useThemeStore.getState());
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.motion).toBe('reduce');
  });
});
