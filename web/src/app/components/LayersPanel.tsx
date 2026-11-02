import { Segmented } from '@/ui/segmented';
import { Slider } from '@/ui/slider';
import { Toggle } from '@/ui/toggle';
import { useViewStore, type ViewState } from '../stores/view';

type LayerKey = Parameters<ViewState['setLayer']>[0];

const LAYERS: readonly { key: LayerKey; label: string }[] = [
  { key: 'showJoints', label: 'Joints' },
  { key: 'showChips', label: 'Name tags' },
  { key: 'showBall', label: 'Ball' },
  { key: 'showTrails', label: 'Ball trail' },
];

/** What the overlay draws and how it is coloured. */
export function LayersPanel() {
  const view = useViewStore();
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Layers</legend>
        {LAYERS.map(({ key, label }) => (
          <Toggle key={key} pressed={view[key]} onPressedChange={(on) => view.setLayer(key, on)}>
            {label}
          </Toggle>
        ))}
      </fieldset>
      <div className="flex flex-col gap-2">
        <p className="font-[550]">Colours</p>
        <Segmented
          label="Colour mode"
          value={view.colorMode}
          options={[
            { value: 'identity', label: 'By player' },
            { value: 'side', label: 'Left / right' },
          ]}
          onChange={view.setColorMode}
        />
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-[550]">Glow</p>
        <Slider
          label="Glow"
          min={0}
          max={1}
          step={0.05}
          value={view.glow}
          valueText={`${Math.round(view.glow * 100)} percent`}
          onValueChange={(v) => view.setGlow(v)}
        />
      </div>
    </div>
  );
}
