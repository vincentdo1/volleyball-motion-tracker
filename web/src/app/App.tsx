import { useActorRef, useSelector } from '@xstate/react';
import { useEffect, useMemo, useState } from 'react';
import { startAppearanceSync } from '@/ui/theme';
import { Toaster } from '@/ui/toaster';
import { TooltipProvider } from '@/ui/tooltip';
import { bridgeEngine } from './bridge';
import { PrivacySheet } from './components/PrivacySheet';
import { ResumeDialog } from './components/ResumeDialog';
import { SettingsSheet } from './components/SettingsSheet';
import { ShortcutsSheet } from './components/ShortcutsSheet';
import { runCapabilityCheck } from './diagnostics';
import { createAppEngine } from './engine-factory';
import { appMachine, lighterTier } from './machine';
import { About } from './screens/About';
import { Landing, type LandingPhase } from './screens/Landing';
import { Problem } from './screens/Problem';
import { Results } from './screens/Results';
import { useEngineStatus } from './stores/engine-status';
import { useSessionStore } from './stores/session';
import { useSettingsStore } from './stores/settings';
import { useUiStore } from './stores/ui';

const ROUTE_ABOUT = '#/about';

/**
 * What the landing screen shows after a file choice, so it never looks idle: while the engine boots with a clip
 * waiting (first visit: model download and warm-up), or initialises again for a changed setting, the analysis is
 * being prepared; once the engine takes the clip, it is being opened.
 */
export function landingPhase(state: string, picked: boolean, enginePreparing: boolean): LandingPhase {
  if (state === 'booting') return picked ? 'preparing' : 'idle';
  if (state === 'probing') return enginePreparing ? 'preparing' : 'opening';
  return 'idle';
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      useUiStore.getState().close();
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

/** Application root: appearance, the engine and the flow machine, plus the `#/about` diagnostics route. */
export function App() {
  const hash = useHash();
  const { engine, mock } = useMemo(() => createAppEngine(window.location.search), []);
  const actor = useActorRef(appMachine, {
    input: { engine, initOptions: () => ({ qualityOptIn: useSettingsStore.getState().qualityMode }) },
  });
  const state = useSelector(actor, (s) => s.value);
  const error = useSelector(actor, (s) => s.context.error);
  const resume = useSelector(actor, (s) => s.context.resume);
  const canFallbackTier = useSelector(actor, (s) => lighterTier(s.context) !== null);
  const pickedName = useSelector(actor, (s) => s.context.file?.name ?? null);
  const enginePreparing = useEngineStatus((s) => s.preparing);
  const durationS = useSessionStore((s) => (s.clip ? s.clip.durationUs / 1e6 : 0));

  useEffect(() => startAppearanceSync(), []);
  // the e2e smoke test and bug reports read window.__caps whatever screen is showing
  useEffect(() => {
    void runCapabilityCheck();
  }, []);
  useEffect(() => bridgeEngine(engine, actor), [engine, actor]);

  const screen = (() => {
    if (hash === ROUTE_ABOUT) return <About />;
    switch (state) {
      case 'booting':
      case 'landing':
      case 'probing':
      case 'offering':
        return (
          <Landing
            onFile={(file) => actor.send({ type: 'PICK', file })}
            phase={landingPhase(state, pickedName !== null, enginePreparing)}
            fileName={pickedName}
            mock={mock}
          />
        );
      case 'analyzing':
      case 'results':
        return (
          <Results
            engine={engine}
            analyzing={state === 'analyzing'}
            onCancel={(keep) => actor.send({ type: 'CANCEL', keep })}
            onNewClip={() => actor.send({ type: 'NEW_CLIP' })}
          />
        );
      case 'error':
      case 'unsupported':
        return error ? (
          <Problem
            error={error}
            terminal={state === 'unsupported'}
            onRetry={() => actor.send({ type: 'RETRY' })}
            onFallbackTier={() => actor.send({ type: 'FALLBACK_TIER' })}
            canFallbackTier={canFallbackTier}
            onNewClip={() => actor.send({ type: 'NEW_CLIP' })}
          />
        ) : null;
    }
  })();

  return (
    <TooltipProvider>
      {screen}
      <SettingsSheet />
      <ShortcutsSheet />
      <PrivacySheet />
      <ResumeDialog
        open={state === 'offering'}
        resume={resume}
        durationS={durationS}
        onContinue={() => actor.send({ type: 'CONTINUE' })}
        onStartOver={() => actor.send({ type: 'START_OVER' })}
        onClose={() => actor.send({ type: 'NEW_CLIP' })}
      />
      <Toaster />
    </TooltipProvider>
  );
}
