import { Info, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/segmented';
import { Sheet } from '@/ui/sheet';
import { type MotionPreference, type ThemePreference, useThemeStore } from '@/ui/theme';
import { toast } from '@/ui/toaster';
import { Toggle } from '@/ui/toggle';
import { useMediaQuery } from '../hooks';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';

const THEMES: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];
const MOTIONS: readonly { value: MotionPreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'reduce', label: 'Reduce' },
  { value: 'full', label: 'Full' },
];

function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-[550]">{title}</p>
      {children}
      {hint && <p className="text-[13px] text-text-2">{hint}</p>}
    </div>
  );
}

/** Theme, motion, the opt-in quality mode and local data (05 §4.8). */
export function SettingsSheet() {
  const open = useUiStore((s) => s.open === 'settings');
  const close = useUiStore((s) => s.close);
  const wide = useMediaQuery('(min-width: 640px)');
  const { theme, motion, setTheme, setMotion } = useThemeStore();
  const { qualityMode, setQualityMode, clearLocalData } = useSettingsStore();
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()} title="Settings" side={wide ? 'right' : 'bottom'}>
      <div className="mt-2 flex flex-col gap-6">
        <Field title="Theme">
          <Segmented label="Theme" value={theme} options={THEMES} onChange={setTheme} />
        </Field>
        <Field title="Motion" hint="Reduce turns off transitions and animations.">
          <Segmented label="Motion" value={motion} options={MOTIONS} onChange={setMotion} />
        </Field>
        <Field
          title="Quality mode"
          hint="Uses a larger detector for crowded or distant scenes. It needs a capable GPU, is slower, and applies to the next clip."
        >
          <div>
            <Toggle pressed={qualityMode} onPressedChange={setQualityMode}>
              {qualityMode ? 'On' : 'Off'}
            </Toggle>
          </div>
        </Field>
        <Field title="Local data" hint="Saved on this device only: settings and the tips you have dismissed.">
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                clearLocalData();
                setTheme('system');
                setMotion('system');
                toast.success('Local data cleared');
              }}
            >
              <Trash2 aria-hidden className="size-4" />
              Clear local data
            </Button>
          </div>
        </Field>
        <a
          href="#/about"
          className="inline-flex items-center gap-2 py-2 text-text-2 [@media(pointer:coarse)]:min-h-11 underline-offset-4 hover:text-text hover:underline"
        >
          <Info aria-hidden className="size-4" />
          About this device
        </a>
      </div>
    </Sheet>
  );
}
