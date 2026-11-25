import { describe, expect, it } from 'vitest';
import { TurnQueue } from './turns';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('TurnQueue', () => {
  it('serves turns in reservation order and never overlaps them', async () => {
    const queue = new TurnQueue();
    const log: string[] = [];
    let active = 0;
    let peak = 0;
    const job = (name: string, ms: number) =>
      queue.exclusive(async () => {
        active++;
        peak = Math.max(peak, active);
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        active--;
      });
    await Promise.all([job('a', 15), job('b', 1), job('c', 5)]);
    expect(peak).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('keeps the reservation order when callers do other work before waiting', async () => {
    const queue = new TurnQueue();
    const first = queue.reserve();
    const second = queue.reserve();
    const order: number[] = [];
    // The second caller is ready to run first but must still wait for the first reservation.
    const b = second.ready.then(() => order.push(2));
    await tick();
    expect(order).toEqual([]);
    await first.ready;
    order.push(1);
    first.release();
    await b;
    expect(order).toEqual([1, 2]);
  });

  it('passes the turn on when work throws or a turn is released twice', async () => {
    const queue = new TurnQueue();
    await expect(
      queue.exclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const turn = queue.reserve();
    turn.release();
    turn.release();
    await expect(queue.exclusive(async () => 7)).resolves.toBe(7);
  });
});
