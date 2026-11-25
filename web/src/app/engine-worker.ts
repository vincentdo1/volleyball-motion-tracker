/**
 * Entry of the engine worker. It only loads `@/engine/engine.worker` (which wires the engine to this worker's port)
 * and keeps itself free of code the rest of the worker shares: the bundler would otherwise hoist that shared code
 * (and with it the engine start-up call) into this entry chunk, which the ML and ORT chunks then import by its own
 * URL. WebKit evaluates a worker's entry module again for such an import, so a second, uninitialised engine would
 * start in the same worker and answer the commands meant for the first one with `invalid-state`.
 *
 * Commands that arrive while the engine module is still loading are held and replayed once it is listening.
 */
const early: MessageEvent[] = [];
const hold = (event: Event) => {
  early.push(event as MessageEvent);
};

self.addEventListener('message', hold);
void import('@/engine/engine.worker').then(() => {
  self.removeEventListener('message', hold);
  for (const event of early) self.dispatchEvent(new MessageEvent('message', { data: event.data }));
  early.length = 0;
});
