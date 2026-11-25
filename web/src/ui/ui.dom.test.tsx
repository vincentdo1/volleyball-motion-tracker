import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Play } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Dialog } from './dialog';
import { IconButton } from './icon-button';
import { Progress } from './progress';
import { Slider } from './slider';
import { Tab, Tabs, TabsList, TabsPanel } from './tabs';
import { Toggle } from './toggle';

afterEach(cleanup);

describe('Button', () => {
  it('fires onClick and respects disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies the variant classes and lets callers override them', () => {
    render(
      <Button variant="primary" className="bg-danger">
        Primary
      </Button>,
    );
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('bg-danger');
    expect(cls).not.toContain('bg-text ');
  });
});

describe('IconButton', () => {
  it('is named by its label and hides the glyph from assistive tech', () => {
    render(<IconButton icon={Play} label="Play" />);
    const button = screen.getByRole('button', { name: 'Play' });
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Toggle', () => {
  it('exposes pressed state', () => {
    render(<Toggle>Joints</Toggle>);
    const toggle = screen.getByRole('button', { name: 'Joints' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Slider', () => {
  it('labels the thumb and reports the spoken value', () => {
    render(
      <Slider label="Timeline" valueText="2.90 s, frame 87" value={3} min={0} max={10} onValueChange={() => {}} />,
    );
    const thumb = screen.getByRole('slider', { name: 'Timeline' });
    expect(thumb.getAttribute('aria-valuetext')).toBe('2.90 s, frame 87');
    expect(thumb.getAttribute('aria-valuenow')).toBe('3');
  });
});

describe('Progress', () => {
  it('exposes its value', () => {
    render(<Progress value={38} label="Finding players" />);
    expect(screen.getByRole('progressbar', { name: 'Finding players' }).getAttribute('aria-valuenow')).toBe('38');
  });
});

describe('Tabs', () => {
  it('switches panels', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <Tab value="a">Players</Tab>
          <Tab value="b">Layers</Tab>
        </TabsList>
        <TabsPanel value="a">first</TabsPanel>
        <TabsPanel value="b">second</TabsPanel>
      </Tabs>,
    );
    expect(screen.getByText('first')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Layers' }));
    expect(screen.getByText('second')).toBeTruthy();
  });
});

describe('Dialog', () => {
  it('renders titled content and closes through the labelled button', async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Privacy" description="Nothing leaves this device.">
        body
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Privacy' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});
