import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The capture script is intentionally plain Node ESM.
import { TOUR_SHOTS, SHOT_SIZE, imageReferences, pngSize, readmeProblems } from '../../scripts/capture-tour.mjs';

interface Shot { name: string; site: string; readme?: string; alt: string }
interface Reference { alt: string; src: string }

/** The smallest PNG header that carries a size: signature plus IHDR. */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe('tour screenshot harness', () => {
  it('reads the size a PNG declares and refuses anything else', () => {
    expect(pngSize(pngHeader(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(() => pngSize(Buffer.from('GIF89a not a png at all'))).toThrow(/not a PNG/);
  });

  it('lists Markdown images with their alt text, including ones inside table cells', () => {
    const markdown = [
      '![Lead](docs/images/a.png)',
      '| ![Left cell](docs/images/b.png) | ![](docs/images/c.png) |',
      '[a link, not an image](docs/images/d.png)',
    ].join('\n');
    expect(imageReferences(markdown)).toEqual<Reference[]>([
      { alt: 'Lead', src: 'docs/images/a.png' },
      { alt: 'Left cell', src: 'docs/images/b.png' },
      { alt: '', src: 'docs/images/c.png' },
    ]);
  });

  it('captures every picture the README tour and the site gallery show, once each', () => {
    const shots = TOUR_SHOTS as readonly Shot[];
    expect(SHOT_SIZE).toEqual({ width: 1280, height: 800 });
    expect(shots.map((shot) => shot.site)).toEqual([
      'tour-quick-open.png',
      'tour-command-palette.png',
      'tour-outline.png',
      'tour-find.png',
      'tour-source.png',
      'tour-settings.png',
    ]);
    expect(shots.flatMap((shot) => (shot.readme ? [shot.readme] : []))).toEqual([
      'noto-quick-open.png',
      'noto-command-palette.png',
      'noto-outline.png',
      'noto-source.png',
    ]);
    expect(new Set(shots.map((shot) => shot.name)).size).toBe(shots.length);
    for (const shot of shots) expect(shot.alt.trim().length).toBeGreaterThan(0);
  });

  it('agrees with the README: every tour picture is referenced with the same alt, and exists at 1280x800', async () => {
    const readme = await readFile(path.join(process.cwd(), 'README.md'), 'utf8');
    expect(await readmeProblems(readme, process.cwd())).toEqual([]);
  });

  it('reports a README tour picture that is missing, unreferenced or described differently', async () => {
    const shots = TOUR_SHOTS as readonly Shot[];
    const quickOpen = shots.find((shot) => shot.name === 'quick-open')!;
    const readme = `| ![Something else](docs/images/${quickOpen.readme}) |\n`;
    const problems: string[] = await readmeProblems(readme, process.cwd());
    expect(problems).toContain(`README alt for docs/images/${quickOpen.readme} is "Something else", expected "${quickOpen.alt}"`);
    expect(problems).toContain('README does not reference docs/images/noto-outline.png');
  });
});
