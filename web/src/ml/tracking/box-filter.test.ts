import { describe, expect, it } from 'vitest';
import { BoxFilter } from './box-filter';

const BOX = [100, 200, 180, 400] as const;

describe('BoxFilter', () => {
  it('predicts the same state whether time passes in one step or many', () => {
    const one = BoxFilter.fromBox(BOX);
    const many = BoxFilter.fromBox(BOX);
    one.update([110, 200, 190, 400]);
    many.update([110, 200, 190, 400]);
    one.predict(0.5, false);
    for (let i = 0; i < 50; i++) many.predict(0.01, false);
    expect(many.box()[0]).toBeCloseTo(one.box()[0], 6);
    // The covariance matches too: the same measurement moves both states by the same amount.
    one.update([150, 200, 230, 400]);
    many.update([150, 200, 230, 400]);
    expect(many.velocity().vx).toBeCloseTo(one.velocity().vx, 6);
  });

  it('learns the velocity of a steadily moving box', () => {
    const f = BoxFilter.fromBox(BOX);
    for (let i = 1; i <= 30; i++) {
      f.predict(1 / 30, false);
      f.update([100 + 3 * i, 200, 180 + 3 * i, 400]);
    }
    expect(f.velocity().vx).toBeCloseTo(90, 0);
    expect(f.velocity().vy).toBeCloseTo(0, 0);
  });

  it('lets a coasting box slow down instead of running off', () => {
    const moving = BoxFilter.fromBox(BOX);
    for (let i = 1; i <= 30; i++) {
      moving.predict(1 / 30, false);
      moving.update([100 + 3 * i, 200, 180 + 3 * i, 400]);
    }
    const coasting = moving.clone();
    const straight = moving.clone();
    coasting.predict(1, true);
    straight.predict(1, false);
    expect(coasting.box()[0]).toBeLessThan(straight.box()[0]);
    expect(coasting.box()[0]).toBeGreaterThan(moving.box()[0]);
  });
});
