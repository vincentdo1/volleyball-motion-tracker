import type { BallLabels } from '../harness/ball.ts';
import ballJson from './ball.json' with { type: 'json' };

/**
 * Ball labels on clips other than gtu (VballNet was trained on gtu): about 160 frames, each visible with a centre and
 * radius or explicitly absent. Frames not listed are unlabelled and never scored.
 */
export const ballLabels: BallLabels = ballJson;
