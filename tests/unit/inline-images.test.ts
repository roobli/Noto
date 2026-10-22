/**
 * Pictures inside an exported file.
 *
 * The editor writes an image's address as the markdown holds it, which is
 * almost always relative to the note. That is right in the note and wrong in an
 * exported page saved anywhere else, and always wrong in a PDF, which is
 * printed from a temporary directory where a relative address resolves to
 * nothing at all.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_INLINE_BYTES,
  inlineImages,
  isLocalReference,
  mediaTypeFor,
} from '../../src/main/workspace/inline-images';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const base64 = Buffer.from(PNG).toString('base64');

const reader = (files: Record<string, Uint8Array>) => async (absolute: string) => {
  const found = files[absolute];
  if (!found) throw new Error(`ENOENT: ${absolute}`);
  return found;
};

describe('mediaTypeFor', () => {
  it('names the type from the extension the protocol already serves', () => {
    expect(mediaTypeFor('/a/b.png')).toBe('image/png');
    expect(mediaTypeFor('/a/b.JPEG')).toBe('image/jpeg');
    expect(mediaTypeFor('/a/b.svg')).toBe('image/svg+xml');
    expect(mediaTypeFor('/a/b.txt')).toBeNull();
    expect(mediaTypeFor('/a/b')).toBeNull();
  });
});

describe('isLocalReference', () => {
  it('is a file, not somewhere else', () => {
    expect(isLocalReference('./assets/a.png')).toBe(true);
    expect(isLocalReference('/vault/a.png')).toBe(true);
    expect(isLocalReference('../shared/a.png')).toBe(true);
  });

  it('leaves a web address alone, since exporting is not a reason to fetch one', () => {
    expect(isLocalReference('https://example.com/a.png')).toBe(false);
    expect(isLocalReference('http://example.com/a.png')).toBe(false);
    expect(isLocalReference('data:image/png;base64,AAAA')).toBe(false);
  });

  it('counts the app\'s own asset scheme as a file, because that is what it is', () => {
    // The drawn page holds these: it is how the renderer asks main for a
    // picture it may not read itself. Export reads the file behind it.
    expect(isLocalReference('noto://asset/x')).toBe(true);
  });
});

describe('inlineImages', () => {
  it('reads a picture relative to the note and writes it into the file', async () => {
    const html = '<p>Before</p><img src="./assets/a.png" alt="a"><p>After</p>';
    const out = await inlineImages(html, {
      noteDirectory: '/vault/notes',
      read: reader({ '/vault/notes/assets/a.png': PNG }),
    });
    expect(out).toContain(`src="data:image/png;base64,${base64}"`);
    // Everything else is untouched.
    expect(out).toContain('alt="a"');
    expect(out).toContain('<p>Before</p>');
  });

  it('resolves an address that climbs out of the note folder', async () => {
    const out = await inlineImages('<img src="../shared/a.png">', {
      noteDirectory: '/vault/notes',
      read: reader({ '/vault/shared/a.png': PNG }),
    });
    expect(out).toContain('data:image/png;base64,');
  });

  it('decodes a percent-encoded address, which is what the editor writes', async () => {
    // A folder with a space or a Chinese character in its name is encoded in
    // the markdown and has to be decoded to be found on disk.
    const out = await inlineImages('<img src="./my%20pics/a.png">', {
      noteDirectory: '/vault',
      read: reader({ '/vault/my pics/a.png': PNG }),
    });
    expect(out).toContain('data:image/png;base64,');
  });

  it('leaves a web address exactly as it was', async () => {
    const html = '<img src="https://example.com/a.png">';
    expect(await inlineImages(html, {
      noteDirectory: '/vault',
      read: async () => { throw new Error('should not have read anything'); },
    })).toBe(html);
  });

  it('leaves a picture that is not there, rather than dropping the reference', async () => {
    // The exported file then shows the same broken reference the note shows,
    // which is something the author can see and fix.
    const html = '<img src="./missing.png">';
    expect(await inlineImages(html, { noteDirectory: '/vault', read: reader({}) })).toBe(html);
  });

  it('leaves a picture too large to be worth carrying', async () => {
    const huge = new Uint8Array(MAX_INLINE_BYTES + 1);
    huge.set(PNG);
    const html = '<img src="./huge.png">';
    expect(await inlineImages(html, {
      noteDirectory: '/vault',
      read: reader({ '/vault/huge.png': huge }),
    })).toBe(html);
  });

  it('reads a picture used twice only once, and replaces both', async () => {
    let reads = 0;
    const out = await inlineImages('<img src="./a.png"><img src="./a.png">', {
      noteDirectory: '/vault',
      read: async () => { reads += 1; return PNG; },
    });
    expect(reads).toBe(1);
    expect(out.match(/data:image\/png/g)).toHaveLength(2);
  });

  it('does nothing at all to a document with no pictures', async () => {
    const html = '<h1>Title</h1><p>Words.</p>';
    expect(await inlineImages(html, {
      noteDirectory: '/vault',
      read: async () => { throw new Error('should not have read anything'); },
    })).toBe(html);
  });

  it('does not read a file the session refuses', async () => {
    const html = '<img src="../../secret.png">';
    let reads = 0;
    const out = await inlineImages(html, {
      noteDirectory: '/vault/notes',
      read: async () => { reads += 1; return PNG; },
      resolve: async () => null,
    });
    expect(reads).toBe(0);
    expect(out).toBe(html);
  });

  it('reads the real path the session approved', async () => {
    const seen: string[] = [];
    const out = await inlineImages('<img src="./a.png">', {
      noteDirectory: '/vault/notes',
      read: async (absolute) => { seen.push(absolute); return PNG; },
      resolve: async (absolute) => {
        expect(absolute).toBe('/vault/notes/a.png');
        return '/real/vault/a.png';
      },
    });
    expect(seen).toEqual(['/real/vault/a.png']);
    expect(out).toContain('data:image/png;base64,');
  });
});
