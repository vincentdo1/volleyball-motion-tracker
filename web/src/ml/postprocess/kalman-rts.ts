/**
 * Constant-velocity Kalman filter followed by a Rauch-Tung-Striebel smoother for one scalar series sampled at
 * arbitrary (PTS-derived) times. Process noise is a piecewise-constant acceleration with the given standard deviation;
 * a measurement further than `gateSigma` standard deviations from the prediction is treated as missing, unless
 * measurements have been refused for `RESEED_AFTER_S`, which means the model is wrong, not the data.
 */

/** Initial velocity uncertainty is the acceleration noise integrated over this long. */
const INITIAL_VELOCITY_HORIZON_S = 0.25;
/** After this long without an accepted measurement the next one is accepted whatever the gate says. */
const RESEED_AFTER_S = 0.2;

export interface Series {
  /** Seconds, strictly increasing. */
  readonly times: ArrayLike<number>;
  /** NaN where there is no measurement. */
  readonly values: ArrayLike<number>;
  /** Measurement standard deviation per index (only read where `values` is finite). */
  readonly sigma: ArrayLike<number>;
  /** Acceleration standard deviation per index, the noise driving the step that ends at that index. */
  readonly accel: ArrayLike<number>;
}

/**
 * Smoothed values at every index from the first to the last measurement; NaN before the first and after the last
 * (a series is never extrapolated).
 */
export function smoothSeries(series: Series, gateSigma: number): Float64Array {
  const { times, values, sigma, accel } = series;
  const n = times.length;
  const out = new Float64Array(n).fill(Number.NaN);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(values[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return out;

  const len = last - first + 1;
  // Filtered (f) and predicted (p) state: position, velocity and the three distinct covariance entries.
  const fp = new Float64Array(len);
  const fv = new Float64Array(len);
  const fpp = new Float64Array(len);
  const fpv = new Float64Array(len);
  const fvv = new Float64Array(len);
  const pp = new Float64Array(len);
  const pv = new Float64Array(len);
  const ppp = new Float64Array(len);
  const ppv = new Float64Array(len);
  const pvv = new Float64Array(len);

  let sinceAcceptedS = 0;
  for (let k = 0; k < len; k++) {
    const i = first + k;
    const z = values[i] as number;
    if (k === 0) {
      const a = accel[i] as number;
      const s = sigma[i] as number;
      fp[0] = z;
      fv[0] = 0;
      fpp[0] = s * s;
      fpv[0] = 0;
      fvv[0] = (a * INITIAL_VELOCITY_HORIZON_S) ** 2;
      continue;
    }
    const dt = (times[i] as number) - (times[i - 1] as number);
    const q = (accel[i] as number) ** 2;
    const p0 = fp[k - 1] as number;
    const v0 = fv[k - 1] as number;
    pp[k] = p0 + v0 * dt;
    pv[k] = v0;
    ppp[k] =
      (fpp[k - 1] as number) + 2 * dt * (fpv[k - 1] as number) + dt * dt * (fvv[k - 1] as number) + (q * dt ** 4) / 4;
    ppv[k] = (fpv[k - 1] as number) + dt * (fvv[k - 1] as number) + (q * dt ** 3) / 2;
    pvv[k] = (fvv[k - 1] as number) + q * dt * dt;
    sinceAcceptedS += dt;

    fp[k] = pp[k] as number;
    fv[k] = pv[k] as number;
    fpp[k] = ppp[k] as number;
    fpv[k] = ppv[k] as number;
    fvv[k] = pvv[k] as number;
    if (!Number.isFinite(z)) continue;
    const r = (sigma[i] as number) ** 2;
    const s = (ppp[k] as number) + r;
    const innovation = z - (pp[k] as number);
    if (innovation * innovation > gateSigma * gateSigma * s && sinceAcceptedS < RESEED_AFTER_S) continue;
    const k0 = (ppp[k] as number) / s;
    const k1 = (ppv[k] as number) / s;
    fp[k] = (pp[k] as number) + k0 * innovation;
    fv[k] = (pv[k] as number) + k1 * innovation;
    fvv[k] = (pvv[k] as number) - k1 * (ppv[k] as number);
    fpv[k] = (ppv[k] as number) - k0 * (ppv[k] as number);
    fpp[k] = (ppp[k] as number) - k0 * (ppp[k] as number);
    sinceAcceptedS = 0;
  }

  // Backward pass: smoothed state x_s[k] = x_f[k] + C (x_s[k+1] - x_p[k+1]), C = P_f[k] F^T P_p[k+1]^-1.
  const sp = new Float64Array(len);
  const sv = new Float64Array(len);
  sp[len - 1] = fp[len - 1] as number;
  sv[len - 1] = fv[len - 1] as number;
  for (let k = len - 2; k >= 0; k--) {
    const dt = (times[first + k + 1] as number) - (times[first + k] as number);
    // P_f F^T = [[ppp + dt ppv, ppv], [ppv + dt pvv, pvv]].
    const a00 = (fpp[k] as number) + dt * (fpv[k] as number);
    const a01 = fpv[k] as number;
    const a10 = (fpv[k] as number) + dt * (fvv[k] as number);
    const a11 = fvv[k] as number;
    const m00 = ppp[k + 1] as number;
    const m01 = ppv[k + 1] as number;
    const m11 = pvv[k + 1] as number;
    const det = m00 * m11 - m01 * m01;
    const dp = (sp[k + 1] as number) - (pp[k + 1] as number);
    const dv = (sv[k + 1] as number) - (pv[k + 1] as number);
    if (!(Math.abs(det) > 1e-12)) {
      sp[k] = fp[k] as number;
      sv[k] = fv[k] as number;
      continue;
    }
    // C = A M^-1, M^-1 = [[m11, -m01], [-m01, m00]] / det.
    const c00 = (a00 * m11 - a01 * m01) / det;
    const c01 = (-a00 * m01 + a01 * m00) / det;
    const c10 = (a10 * m11 - a11 * m01) / det;
    const c11 = (-a10 * m01 + a11 * m00) / det;
    sp[k] = (fp[k] as number) + c00 * dp + c01 * dv;
    sv[k] = (fv[k] as number) + c10 * dp + c11 * dv;
  }
  for (let k = 0; k < len; k++) out[first + k] = sp[k] as number;
  return out;
}
