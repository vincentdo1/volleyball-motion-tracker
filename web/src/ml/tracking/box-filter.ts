/**
 * Constant-velocity Kalman filter for a person box, state (cx, cy, h, a) with a = w / h and one velocity per
 * component. The four components are independent, so each is a scalar position/velocity pair with a 2x2 covariance.
 * Process noise is the continuous white-noise-acceleration model, which makes a predict over `dt` equal to any
 * number of predicts that add up to `dt` (frame-rate invariant); its units are noted on the constants.
 */
import type { Box } from '../geometry';

/** Velocity-change spectral density of cx, cy and h, in box heights squared per second cubed (scaled by h^2). */
const MOTION_NOISE = { centre: 9, height: 2 };
/** Same for the aspect ratio, which is unit-less (not scaled by h). */
const ASPECT_NOISE = 0.5;
/** Detector box noise, as a fraction of the box height (cx, cy, h) and absolute (aspect). */
const MEASUREMENT_SIGMA = { centre: 0.04, height: 0.04, aspect: 0.06 };
/** Initial velocity uncertainty, in box heights per second. */
const INITIAL_VELOCITY_SIGMA = 1;
/** Time constant of the velocity decay while no detection supports the track (a lost player stops, not flies off). */
const COASTING_VELOCITY_DECAY_S = 0.5;

/** Position and velocity of one scalar component with the three distinct entries of the 2x2 covariance. */
class Axis {
  constructor(
    public p: number,
    public v: number,
    public ppp: number,
    public ppv: number,
    public pvv: number,
  ) {}

  predict(dt: number, noise: number, velocityKeep: number) {
    this.v *= velocityKeep;
    this.pvv *= velocityKeep * velocityKeep;
    this.p += this.v * dt;
    const ppv = this.ppv;
    this.ppp += 2 * dt * ppv + dt * dt * this.pvv + (noise * dt ** 3) / 3;
    this.ppv += dt * this.pvv + (noise * dt * dt) / 2;
    this.pvv += noise * dt;
  }

  update(z: number, variance: number) {
    const s = this.ppp + variance;
    const k0 = this.ppp / s;
    const k1 = this.ppv / s;
    const innovation = z - this.p;
    this.p += k0 * innovation;
    this.v += k1 * innovation;
    this.pvv -= k1 * this.ppv;
    this.ppv -= k0 * this.ppv;
    this.ppp -= k0 * this.ppp;
  }

  clone() {
    return new Axis(this.p, this.v, this.ppp, this.ppv, this.pvv);
  }
}

export interface BoxState {
  readonly cx: number;
  readonly cy: number;
  readonly h: number;
  readonly a: number;
}

function stateOf(box: Box): BoxState {
  const h = Math.max(1e-3, box[3] - box[1]);
  return { cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, h, a: (box[2] - box[0]) / h };
}

export class BoxFilter {
  private constructor(private readonly axes: readonly [Axis, Axis, Axis, Axis]) {}

  static fromBox(box: Box): BoxFilter {
    const s = stateOf(box);
    const vv = (INITIAL_VELOCITY_SIGMA * s.h) ** 2;
    const axis = (p: number, sigma: number, velocityVar: number) => new Axis(p, 0, sigma * sigma, 0, velocityVar);
    return new BoxFilter([
      axis(s.cx, MEASUREMENT_SIGMA.centre * s.h, vv),
      axis(s.cy, MEASUREMENT_SIGMA.centre * s.h, vv),
      axis(s.h, MEASUREMENT_SIGMA.height * s.h, vv),
      axis(s.a, MEASUREMENT_SIGMA.aspect, INITIAL_VELOCITY_SIGMA ** 2),
    ]);
  }

  clone(): BoxFilter {
    return new BoxFilter(this.axes.map((a) => a.clone()) as [Axis, Axis, Axis, Axis]);
  }

  /** Advances the state by `dtS` seconds; `coasting` damps the velocity (no detection has supported the track). */
  predict(dtS: number, coasting: boolean) {
    if (dtS <= 0) return;
    const keep = coasting ? Math.exp(-dtS / COASTING_VELOCITY_DECAY_S) : 1;
    const [cx, cy, h, a] = this.axes;
    const h2 = h.p * h.p;
    cx.predict(dtS, MOTION_NOISE.centre * h2, keep);
    cy.predict(dtS, MOTION_NOISE.centre * h2, keep);
    h.predict(dtS, MOTION_NOISE.height * h2, keep);
    a.predict(dtS, ASPECT_NOISE, keep);
  }

  update(box: Box) {
    const s = stateOf(box);
    const [cx, cy, h, a] = this.axes;
    cx.update(s.cx, (MEASUREMENT_SIGMA.centre * s.h) ** 2);
    cy.update(s.cy, (MEASUREMENT_SIGMA.centre * s.h) ** 2);
    h.update(s.h, (MEASUREMENT_SIGMA.height * s.h) ** 2);
    a.update(s.a, MEASUREMENT_SIGMA.aspect ** 2);
  }

  state(): BoxState {
    const [cx, cy, h, a] = this.axes;
    return { cx: cx.p, cy: cy.p, h: Math.max(1e-3, h.p), a: Math.max(0.05, a.p) };
  }

  box(): Box {
    const { cx, cy, h, a } = this.state();
    const w = a * h;
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  }

  /** Centre velocity in pixels per second. */
  velocity(): { readonly vx: number; readonly vy: number } {
    return { vx: this.axes[0].v, vy: this.axes[1].v };
  }
}
