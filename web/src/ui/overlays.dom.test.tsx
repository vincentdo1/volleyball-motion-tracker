import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './menu';
import { Sheet } from './sheet';
import { Tooltip, TooltipProvider } from './tooltip';

afterEach(cleanup);

describe('Menu', () => {
  it('opens from its trigger and runs the chosen item', async () => {
    const onFocus = vi.fn();
    render(
      <Menu>
        <MenuTrigger>Player</MenuTrigger>
        <MenuContent>
          <MenuItem onClick={onFocus}>Focus</MenuItem>
          <MenuItem>Hide</MenuItem>
        </MenuContent>
      </Menu>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Player' }));
    });
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Focus', 'Hide']);
    await act(async () => {
      fireEvent.click(items[0] as HTMLElement);
    });
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});

describe('Tooltip', () => {
  it('keeps the trigger reachable and unchanged', () => {
    render(
      <TooltipProvider>
        <Tooltip label="Step forward">
          <button type="button" aria-label="Next frame">
            .
          </button>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Next frame' })).toBeTruthy();
  });
});

describe('Sheet', () => {
  it('renders a titled dialog with a labelled close button', async () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange} title="Export">
        content
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Export' })).toBeTruthy();
    expect(screen.getByText('content')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
