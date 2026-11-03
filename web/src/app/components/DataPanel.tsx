import { TriangleAlert } from 'lucide-react';
import { formatBytes, formatDuration } from '../format';
import { noticeFor } from '../notices';
import { useSessionStore } from '../stores/session';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-border border-t py-2 first:border-t-0">
      <dt className="text-text-2">{label}</dt>
      <dd className="m-0 text-right font-mono text-[13px]">{value}</dd>
    </div>
  );
}

/** Clip facts and anything the engine warned about. */
export function DataPanel() {
  const clip = useSessionStore((s) => s.clip);
  const warnings = useSessionStore((s) => s.warnings);
  if (!clip) return null;
  return (
    <div className="flex flex-col gap-4">
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Notes">
          {warnings.map((warning, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: warnings are append-only
              key={i}
              className="flex gap-2 rounded-input border border-border bg-surface-2/50 p-3 text-[13px]"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-id-5" />
              {noticeFor(warning)?.description ?? warning.message}
            </li>
          ))}
        </ul>
      )}
      <dl className="m-0">
        <Row label="File" value={clip.name} />
        <Row label="Size" value={formatBytes(clip.sizeBytes)} />
        <Row label="Picture" value={`${clip.displayWidth} x ${clip.displayHeight}`} />
        <Row label="Length" value={formatDuration(clip.durationUs / 1e6)} />
        <Row
          label="Frame rate"
          value={`${clip.nominalFps.toFixed(2)} fps${clip.variableFrameRate ? ' (variable)' : ''}`}
        />
        <Row label="Frames" value={String(clip.frameCount)} />
      </dl>
    </div>
  );
}
