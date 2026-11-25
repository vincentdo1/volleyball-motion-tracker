import type { EngineError } from '@/contracts/errors';

/** A recognisable name for a video codec identifier, and whether it is the H.264 family (the one to convert to). */
export interface CodecName {
  readonly name: string;
  readonly h264: boolean;
}

const FAMILIES: readonly { readonly match: RegExp; readonly name: string }[] = [
  { match: /^(avc[1-4]|avc|h264)\b/i, name: 'H.264' },
  { match: /^(hvc1|hev1|hevc|h265)\b/i, name: 'HEVC (H.265)' },
  { match: /^(dvh1|dvhe|dva1|dvav)\b/i, name: 'Dolby Vision' },
  { match: /^av01\b|^av1\b/i, name: 'AV1' },
  { match: /^(vp09|vp9)\b/i, name: 'VP9' },
  { match: /^(vp08|vp8)\b/i, name: 'VP8' },
  { match: /^(apc[hnso]|ap4[hx])\b|^prores/i, name: 'Apple ProRes' },
  { match: /^(mp4v|mpeg4)\b/i, name: 'MPEG-4 Visual' },
  { match: /^(mp2v|mpeg2|mpg2)/i, name: 'MPEG-2' },
  { match: /^(s263|h263)\b/i, name: 'H.263' },
  { match: /^(mjpg|mjpeg|jpeg)\b/i, name: 'Motion JPEG' },
  { match: /^(wmv\d?|vc-?1|wvc1)\b/i, name: 'Windows Media Video' },
  { match: /^theora\b/i, name: 'Theora' },
];

/** The recognisable name of a codec identifier such as `hvc1.1.6.L93.B0` or `av01.0.08M.08`; null when unknown. */
export function codecName(raw: string): CodecName | null {
  const id = raw.trim();
  for (const family of FAMILIES) {
    if (family.match.test(id)) return { name: family.name, h264: family.name === 'H.264' };
  }
  return null;
}

/** Codec identifiers inside a sentence: the four-letter family plus its dotted parameters. */
const IDENTIFIER = /\b(?:avc[1-4]|hvc1|hev1|dvh[1e]|av01|vp0[89]|mp4v|ap[cnso4][hxn]?)(?:\.[0-9A-Za-z]+)*/g;

/** Replaces raw codec identifiers in a message with their names, so no identifier shows in the explanation. */
export function humanizeCodecs(text: string): string {
  return text.replace(IDENTIFIER, (raw) => codecName(raw)?.name ?? raw);
}

function detailString(error: EngineError, key: string): string | null {
  const value = error.detail?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The codec identifier an engine error carries: its detail, else the one named in the message (`decode X video`). */
export function rawCodecOf(error: EngineError): string | null {
  return detailString(error, 'codec') ?? /decode (\S+) video/i.exec(error.message)?.[1] ?? null;
}

export interface ProblemText {
  /** The sentence under the title, or null to show none. */
  readonly explanation: string | null;
  /** What to do next, or null when the generic hint applies. */
  readonly nextStep: string | null;
  /** Everything technical on one line, for the copyable details: code, codec, other context. */
  readonly detailsLine: string;
}

const CONVERT = 'Convert it to an H.264 MP4 (HandBrake or ffmpeg can) and choose it again, or try Chrome or Edge.';

/** The technical context of an error as `key: value` pairs, raw identifiers included. */
function detailsLineOf(error: EngineError): string {
  const parts: string[] = [error.code];
  for (const [key, value] of Object.entries(error.detail ?? {})) {
    if (value !== null && value !== '') parts.push(`${key}: ${value}`);
  }
  return parts.join(' | ');
}

/**
 * User-facing wording for the file problems: an unsupported codec (readable and a different browser or format would
 * help) and a damaged file (the file itself is the problem) stay clearly distinct. The raw identifier never appears
 * in the explanation; it stays in `detailsLine`.
 */
export function problemText(error: EngineError): ProblemText {
  const detailsLine = detailsLineOf(error);
  if (error.code === 'unsupported-codec') {
    const raw = rawCodecOf(error);
    const codec = raw ? codecName(raw) : null;
    const explanation = codec
      ? codec.h264
        ? 'This clip is H.264, but in a form this browser cannot decode.'
        : `This clip is encoded as ${codec.name}, which this browser cannot decode.`
      : 'This clip uses a video format this browser cannot decode.';
    return { explanation, nextStep: CONVERT, detailsLine };
  }
  if (error.code === 'corrupt-file') {
    return {
      explanation: humanizeCodecs(error.message),
      nextStep:
        'Copy or download the file again, or export it again from the app that made it. If other players open it fine, convert it to an H.264 MP4 and choose that.',
      detailsLine,
    };
  }
  return { explanation: null, nextStep: null, detailsLine };
}
