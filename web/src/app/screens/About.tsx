import { Activity, Cpu, Film, Gauge, HardDrive, ShieldCheck } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { type CapabilityReport, DEVICE_TIERS } from '@/contracts/capabilities';
import type { OrtSelfTestResult } from '@/engine/selftest/ort-selftest';
import { AppHeader } from '../components/AppHeader';
import { runCapabilityCheck, runSelfTest } from '../diagnostics';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

const toneClass: Record<Tone, string> = {
  ok: 'bg-id-6',
  warn: 'bg-id-5',
  bad: 'bg-danger',
  idle: 'bg-text-2',
};

function Row({ label, value, tone, testId }: { label: string; value: string; tone: Tone; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-border border-t py-2 first:border-t-0">
      <span className="text-text-2">{label}</span>
      <span className="flex items-center gap-2 text-right font-mono text-[13px]">
        <span aria-hidden className={`inline-block size-2 shrink-0 rounded-pill ${toneClass[tone]}`} />
        <span data-testid={testId}>{value}</span>
      </span>
    </div>
  );
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-border bg-surface-1 p-4 shadow-elev-1">
      <h2 className="mb-2 flex items-center gap-2 font-[550] text-[13px] text-text-2 uppercase tracking-wide">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

const yesNo = (v: boolean | null): string => (v === null ? 'n/a' : v ? 'yes' : 'no');
const toneOf = (v: boolean | null): Tone => (v === null ? 'idle' : v ? 'ok' : 'bad');

/** `#/about`: device diagnostics (capabilities, chosen device tier, ORT module-worker self-test). */
export function About() {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [selfTest, setSelfTest] = useState<OrtSelfTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    runCapabilityCheck()
      .then(async (caps) => {
        if (cancelled) return;
        setReport(caps);
        const result = await runSelfTest(caps);
        if (!cancelled) setSelfTest(result);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const gpu = report?.webgpu;
  const adapter = gpu?.adapter;
  const tier = report?.recommendedTier ? DEVICE_TIERS[report.recommendedTier] : null;

  return (
    <div className="min-h-dvh">
      <AppHeader showPrivacy={false} />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
        <header>
          <h1 className="font-semibold text-[24px] tracking-tight">About this device</h1>
          <p className="text-text-2">Device check. Videos are processed on this device and never uploaded.</p>
        </header>

        {error && (
          <p role="alert" className="rounded-card border border-danger p-3 text-danger">
            {error}
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Card icon={<ShieldCheck size={16} strokeWidth={1.5} />} title="Isolation">
            <Row
              label="crossOriginIsolated"
              value={report ? String(report.crossOriginIsolated) : '…'}
              tone={report ? toneOf(report.crossOriginIsolated) : 'idle'}
              testId="cap-isolated"
            />
            <Row
              label="Secure context"
              value={report ? yesNo(report.secureContext) : '…'}
              tone={toneOf(report?.secureContext ?? null)}
            />
            <Row
              label="WASM SIMD / threads / JSPI"
              value={
                report ? `${yesNo(report.wasm.simd)} / ${yesNo(report.wasm.threads)} / ${yesNo(report.wasm.jspi)}` : '…'
              }
              tone={report?.wasm.simd ? 'ok' : 'idle'}
            />
          </Card>

          <Card icon={<Cpu size={16} strokeWidth={1.5} />} title="WebGPU">
            <Row
              label="Adapter"
              value={!report ? '…' : gpu?.realAdapter ? 'real' : gpu?.available ? 'fallback' : 'unavailable'}
              tone={!report ? 'idle' : gpu?.realAdapter ? 'ok' : 'bad'}
              testId="cap-webgpu"
            />
            <Row
              label="Vendor / architecture"
              value={adapter ? `${adapter.vendor || '?'} / ${adapter.architecture || '?'}` : '—'}
              tone={adapter ? 'ok' : 'idle'}
              testId="cap-adapter"
            />
            <Row
              label="shader-f16"
              value={report ? yesNo(gpu?.shaderF16 ?? false) : '…'}
              tone={toneOf(gpu?.shaderF16 ?? null)}
            />
            <Row
              label="Max buffer"
              value={adapter ? `${Math.round((adapter.limits.maxBufferSize ?? 0) / 2 ** 20)} MiB` : '—'}
              tone="idle"
            />
          </Card>

          <Card icon={<Film size={16} strokeWidth={1.5} />} title="WebCodecs">
            <Row
              label="Decoder / encoder"
              value={report ? `${yesNo(report.webcodecs.videoDecoder)} / ${yesNo(report.webcodecs.videoEncoder)}` : '…'}
              tone={report?.webcodecs.videoDecoder ? 'ok' : 'idle'}
              testId="cap-webcodecs"
            />
            <Row
              label="H.264 decode / encode"
              value={report ? `${yesNo(report.webcodecs.h264Decode)} / ${yesNo(report.webcodecs.h264Encode)}` : '…'}
              tone={toneOf(report?.webcodecs.h264Decode ?? null)}
            />
            <Row
              label="HEVC decode"
              value={report ? yesNo(report.webcodecs.hevcDecode) : '…'}
              tone={report?.webcodecs.hevcDecode ? 'ok' : 'warn'}
            />
          </Card>

          <Card icon={<Gauge size={16} strokeWidth={1.5} />} title="Device tier">
            <Row
              label="Chosen tier"
              value={report ? (report.recommendedTier ?? 'unsupported') : '…'}
              tone={!report ? 'idle' : report.recommendedTier ? 'ok' : 'bad'}
              testId="cap-tier"
            />
            <Row label="Models" value={tier ? `${tier.models.detector} → ${tier.models.pose}` : '—'} tone="idle" />
            <Row label="ORT build" value={report?.ortFlavor ?? '—'} tone="idle" />
            <p className="pt-2 text-[13px] text-text-2">{report?.reasons.join(' · ')}</p>
          </Card>

          <Card icon={<Activity size={16} strokeWidth={1.5} />} title="Inference self-test (module worker)">
            <Row
              label="Status"
              value={!selfTest ? 'running' : selfTest.ok ? 'ok' : 'failed'}
              tone={!selfTest ? 'idle' : selfTest.ok ? 'ok' : 'bad'}
              testId="ort-selftest"
            />
            <Row
              label="Backend / threads"
              value={selfTest ? `${selfTest.backend} / ${selfTest.numThreads}` : '…'}
              tone="idle"
            />
            <Row label="Output" value={selfTest?.outputDims.length ? selfTest.outputDims.join('×') : '—'} tone="idle" />
            <Row
              label="Create / first run"
              value={selfTest ? `${selfTest.createMs} / ${selfTest.runMs} ms` : '…'}
              tone="idle"
            />
            {selfTest?.error && <p className="pt-2 text-[13px] text-danger">{selfTest.error}</p>}
          </Card>

          <Card icon={<HardDrive size={16} strokeWidth={1.5} />} title="Storage">
            <Row
              label="OPFS"
              value={report ? yesNo(report.storage.opfs) : '…'}
              tone={toneOf(report?.storage.opfs ?? null)}
            />
            <Row label="Persisted" value={report ? yesNo(report.storage.persisted) : '…'} tone="idle" />
            <Row
              label="Quota"
              value={report?.storage.quotaBytes ? `${(report.storage.quotaBytes / 2 ** 30).toFixed(1)} GiB` : '—'}
              tone="idle"
            />
          </Card>
        </div>
      </main>
    </div>
  );
}
