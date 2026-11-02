import type { Evaluation } from './evaluate.ts';

const GROUPS = [
  'ALL',
  'closeup',
  'practice',
  'beach',
  'wide_match',
  'motion',
  'primary_closeup',
  'primary_practice',
  'primary_beach',
  'primary_wide_match',
];

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  if (Math.abs(value) >= 10) return String(value);
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** Markdown tables in the layout of the bake-off report (06 §2.1 and §2.2). */
export function toMarkdown(evaluation: Evaluation): string {
  const lines: string[] = [];
  const configs = Object.entries(evaluation.configs);
  for (const group of GROUPS) {
    const rows = configs.filter(([, config]) => config.groups[group]);
    const first = rows[0]?.[1].groups[group];
    if (!first) continue;
    lines.push(
      '',
      `#### ${group} (${first.frames} frames, ${first.gtPersons} GT persons, target=${evaluation.target}, frames=${evaluation.frames})`,
      '',
      '| config | recall@.5 | recall@.75 | box recall | PCK@.1 | PCK@.05 | PCK@.05 wrists | PCK@.05 all-GT | mean OKS (matched) | likely FP/frame | unmatched/frame | mean kp score |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const [label, config] of rows) {
      const s = config.groups[group];
      if (!s) continue;
      lines.push(
        `| ${label} | ${[s.recall50, s.recall75, s.boxRecall, s.pck10, s.pck05, s.pck05Wrists, s.pck05All, s.meanOksMatched, s.likelyFpPerFrame, s.unmatchedPerFrame, s.meanKpScore].map(fmt).join(' | ')} |`,
      );
    }
  }
  const clips = [...new Set(configs.flatMap(([, config]) => Object.keys(config.jitter)))];
  if (clips.length) {
    lines.push(
      '',
      '#### Jitter on consecutive runs (raw per-frame output; mean |second difference| as % of box height per frame²)',
      '',
      `| config | ${clips.map((c) => `${c} torso accel (teacher) | ${c} all-joint accel err | ${c} continuity`).join(' | ')} |`,
      `|---|${clips.map(() => '---|---|---|').join('')}`,
    );
    for (const [label, config] of configs) {
      const cells = clips.map((clip) => {
        const j = config.jitter[clip];
        return j?.torso && j.all
          ? `${fmt(j.torso.predAccelPct)} (${fmt(j.torso.teacherAccelPct)}) | ${fmt(j.all.accelErrPct)} | ${fmt(j.continuity)}`
          : '– | – | –';
      });
      lines.push(`| ${label} | ${cells.join(' | ')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
