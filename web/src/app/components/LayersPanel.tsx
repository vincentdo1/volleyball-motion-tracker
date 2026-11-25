import { Segmented } from '@/ui/segmented';
import { Slider } from '@/ui/slider';
import { Toggle } from '@/ui/toggle';
import { useDrawStatus, useViewStore, type ViewState } from '../stores/view';

type LayerKey = Parameters<ViewState['setLayer']>[0];

const LAYERS: readonly { key: LayerKey; label: string }[] = [
  { key: 'showJoints', label: 'Joints' },
  { key: 'showChips', label: 'Name tags' },
  { key: 'showBall', label: 'Ball' },
  { key: 'showTrails', label: 'Ball trail' },
];

/** Layers drawn for the focus player only. */
const FOCUS_LAYERS: readonly { key: LayerKey; label: string }[] = [
  { key: 'showFocusTrails', label: 'Hand trails' },
  { key: 'showGhosts', label: 'Ghosts' },
  { key: 'showAngles', label: 'Angles' },
];

type ColourChoice = 'identity' | 'side' | 'velocity';

/** The note under the focus layers. It alone follows the draw loop's report, so a flip repaints this line only. */
function FocusLayersNote({ focused, ghosts }: { focused: boolean; ghosts: boolean }) {
  const still = useDrawStatus((s) => s.ghostsStill);
  return (
    <p className="text-[13px] text-text-2" data-testid="focus-layers-note">
      {!focused
        ? 'Pick a player on the video or in the list to see these.'
        : ghosts && still
          ? 'Ghosts need the player to move across the frame; this stretch does not.'
          : 'Drawn for the player you picked.'}
    </p>
  );
}

/** What the overlay draws and how it is coloured. */
export function LayersPanel() {
  const view = useViewStore();
  const hasFocus = view.focusTrackId !== null;
  const colour: ColourChoice = view.velocityColor ? 'velocity' : view.colorMode;
  const pickColour = (next: ColourChoice) => {
    view.setVelocityColor(next === 'velocity');
    if (next !== 'velocity') view.setColorMode(next);
  };
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
        <p className="font-[550]">Focus player</p>
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">Focus player layers</legend>
          {FOCUS_LAYERS.map(({ key, label }) => (
            <Toggle key={key} pressed={view[key]} onPressedChange={(on) => view.setLayer(key, on)}>
              {label}
            </Toggle>
          ))}
        </fieldset>
        <FocusLayersNote focused={view.focusTrackId !== null} ghosts={view.showGhosts} />
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-[550]">Colours</p>
        <Segmented
          label="Colour mode"
          value={colour}
          options={[
            { value: 'identity', label: 'By player' },
            { value: 'side', label: 'Left / right' },
            // speed colours go to the focus player only: without one the choice would do nothing
            { value: 'velocity', label: 'By speed', disabled: !hasFocus && colour !== 'velocity' },
          ]}
          onChange={pickColour}
          describedBy="colour-note"
        />
        <p id="colour-note" className="text-[13px] text-text-2" data-testid="colour-note">
          {hasFocus
            ? 'By speed colours the player you picked. Everyone else keeps the colours of your last By player or Left / right choice.'
            : 'By speed needs a picked player: pick one on the video or in the list.'}
        </p>
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
