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
import { appMachine } from './machine';
import { About } from './screens/About';
import { Landing } from './screens/Landing';
import { Problem } from './screens/Problem';
import { Results } from './screens/Results';
import { useSessionStore } from './stores/session';
import { useSettingsStore } from './stores/settings';
import { useUiStore } from './stores/ui';

const ROUTE_ABOUT = '#/about';

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
        return <Landing onFile={(file) => actor.send({ type: 'PICK', file })} busy={state === 'probing'} mock={mock} />;
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
