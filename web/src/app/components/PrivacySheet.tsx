import { Cpu, Lock, WifiOff } from 'lucide-react';
import { Sheet } from '@/ui/sheet';
import { useUiStore } from '../stores/ui';

const POINTS = [
  {
    icon: Cpu,
    title: 'Analysis runs on your device',
    body: 'Pose and ball tracking use WebGPU or WebAssembly inside this tab. There is no server doing the work.',
  },
  {
    icon: Lock,
    title: 'Your video is never uploaded',
    body: 'The app makes no network requests with your media. Open your browser developer tools and watch the Network tab to check.',
  },
  {
    icon: WifiOff,
    title: 'Works offline',
    body: 'After the first visit the app and its models are cached, so you can analyse clips without a connection.',
  },
] as const;

export function PrivacySheet() {
  const open = useUiStore((s) => s.open === 'privacy');
  const close = useUiStore((s) => s.close);
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()} title="How private is this?" side="right">
      <ul className="mt-2 flex flex-col gap-5">
        {POINTS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-3">
            <Icon aria-hidden className="mt-0.5 shrink-0 text-accent" />
            <div>
              <h3 className="font-[550]">{title}</h3>
              <p className="mt-1 text-text-2">{body}</p>
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
