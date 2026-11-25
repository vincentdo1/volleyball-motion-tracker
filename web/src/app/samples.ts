export interface SampleClip {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/**
 * Sample clips load from the dev server's fixture route, so they exist in development and mock runs only.
 * A production deployment offers samples once clips are hosted next to the app.
 */
export const SAMPLE_CLIPS: readonly SampleClip[] = [
  { id: 'indoor', title: 'Indoor spike', url: '/__fixtures/videos/volleyball_spike_attempt_03.mp4' },
  { id: 'beach', title: 'Beach rally', url: '/__fixtures/videos/github_beach_st_lenina_20250622_g1_005.mp4' },
  { id: 'wide', title: 'Wide match', url: '/__fixtures/videos/github_gtu_20250316_002_volleyball_tracking.mp4' },
];

export const samplesAvailable = (mock: boolean): boolean => import.meta.env.DEV || mock;

export async function fetchSample(sample: SampleClip): Promise<File> {
  const response = await fetch(sample.url);
  if (!response.ok) throw new Error(`could not load ${sample.title} (${response.status})`);
  const name = sample.url.split('/').pop() ?? `${sample.id}.mp4`;
  return new File([await response.blob()], name, { type: 'video/mp4' });
}
