import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8')) as {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

describe('web app manifest', () => {
  it('names the app Skeletal and installs it standalone', () => {
    expect(manifest.name).toBe('Skeletal');
    expect(manifest.short_name).toBe('Skeletal');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(html).toContain('<title>Skeletal</title>');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain(`name="theme-color" content="${manifest.theme_color}"`);
  });

  it('ships 192 and 512 px PNGs, an SVG and a maskable icon, all present on disk', () => {
    const has = (sizes: string, type: string, purpose?: string) =>
      manifest.icons.some((i) => i.sizes === sizes && i.type === type && (purpose ? i.purpose === purpose : true));
    expect(has('192x192', 'image/png')).toBe(true);
    expect(has('512x512', 'image/png')).toBe(true);
    expect(has('any', 'image/svg+xml')).toBe(true);
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) expect(existsSync(resolve(root, `public${icon.src}`))).toBe(true);
  });
});
