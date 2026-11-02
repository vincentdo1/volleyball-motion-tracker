import type { EngineState } from '@/contracts/protocol';

/** Legal transitions (plan §3.4). `processing` and `paused` are the two halves of the run state. */
const TRANSITIONS: Readonly<Record<EngineState, readonly EngineState[]>> = {
  idle: ['initializing', 'disposed'],
  initializing: ['ready', 'failed', 'disposed'],
  ready: ['opening', 'failed', 'disposed'],
  opening: ['opened', 'failed', 'disposed'],
  opened: ['opening', 'processing', 'failed', 'disposed'],
  processing: ['paused', 'finalizing', 'opened', 'failed', 'disposed'],
  paused: ['processing', 'opened', 'failed', 'disposed'],
  finalizing: ['done', 'failed', 'disposed'],
  done: ['opening', 'failed', 'disposed'],
  failed: ['initializing', 'opening', 'disposed'],
  disposed: [],
};

export function canTransition(from: EngineState, to: EngineState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Tracks the engine state and reports every change; refuses illegal transitions. */
export class StateMachine {
  private current: EngineState = 'idle';

  constructor(private readonly onChange: (state: EngineState, previous: EngineState) => void) {}

  get state(): EngineState {
    return this.current;
  }

  is(...states: readonly EngineState[]): boolean {
    return states.includes(this.current);
  }

  transition(next: EngineState): void {
    if (next === this.current) return;
    if (!canTransition(this.current, next)) {
      throw new Error(`illegal engine state transition ${this.current} -> ${next}`);
    }
    const previous = this.current;
    this.current = next;
    this.onChange(next, previous);
  }
}
