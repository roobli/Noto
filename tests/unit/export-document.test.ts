/**
 * Writing a note out as something else.
 *
 * Two jobs behind one menu: the document formats are a conversion of the
 * markdown that Pandoc does from the file, and PDF and HTML are the document as
 * Noto draws it. What is tested here is the deciding, the naming and the
 * refusing, since the conversion itself is Pandoc's.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_TARGETS,
  exportArguments,
  exportShape,
  exportThroughPandoc,
  needsPandoc,
  readArguments,
  suggestedName,
} from '../../src/main/workspace/export-document';
import { standaloneHtml, escapeHtml } from '../../src/shared/export/document-html';
import { EXPORT_PALETTE_COMMANDS, EXPORT_TARGET_SHAPES } from '../../src/shared/export/targets';
import { EXPORT_KINDS } from '../../src/shared/workspace/v1/contracts';

describe('the export targets', () => {
  it('renders PDF and HTML itself, and converts the rest', () => {
    // What PDF and HTML are for is how the note looks, which Pandoc has never
    // seen, so they never go through it.
    expect(needsPandoc('pdf')).toBe(false);
    expect(needsPandoc('html')).toBe(false);
    expect(needsPandoc('docx')).toBe(true);
    expect(needsPandoc('epub')).toBe(true);
  });

  it('offers what Typora offers', () => {
    expect(EXPORT_TARGETS).toContain('docx');
    expect(EXPORT_TARGETS).toContain('opml');
    expect(EXPORT_TARGETS).toContain('mediawiki');
    expect(EXPORT_TARGETS).toContain('html-plain');
  });

  it('is the same set the boundary carries, not a second list beside it', () => {
    // They were two lists once and `html-plain` was in one and not the other,
    // which turned into a crash at the moment of export rather than a type
    // error at the moment of writing.
    expect([...EXPORT_TARGETS].sort()).toEqual([...EXPORT_KINDS].sort());
    for (const kind of EXPORT_KINDS) {
      expect(() => exportShape(kind)).not.toThrow();
      expect(typeof needsPandoc(kind)).toBe('boolean');
    }
  });

  it('gives each one the extension its format actually uses', () => {
    expect(exportShape('latex').extension).toBe('tex');
    expect(exportShape('mediawiki').extension).toBe('wiki');
    expect(exportShape('docx').extension).toBe('docx');
  });
});

describe('suggestedName', () => {
  it('keeps the note name and changes the extension', () => {
    expect(suggestedName('/vault/Quarterly Report.md', 'docx')).toBe('Quarterly Report.docx');
    expect(suggestedName('/vault/研究笔记.md', 'pdf')).toBe('研究笔记.pdf');
    expect(suggestedName('/vault/notes.v2.md', 'html')).toBe('notes.v2.html');
  });
});

describe('exportArguments', () => {
  it('converts the vetted document, sandboxed, into a standalone file', () => {
    expect(exportArguments('/tmp/noto-export-1/note.json', '/out/report.docx', 'docx')).toEqual([
      // Pandoc reads nothing but the document it is handed: no picture, no
      // include, nothing a shared note names from elsewhere on the disk.
      '--sandbox',
      '--from', 'json',
      '--to', 'docx',
      // A fragment is useless in every one of these formats.
      '--standalone',
      '--output', '/out/report.docx',
      '--', '/tmp/noto-export-1/note.json',
    ]);
  });

  it('reads the note sandboxed too', () => {
    expect(readArguments('/vault/notes/report.md')).toEqual([
      '--sandbox', '--from', 'gfm', '--to', 'json', '--', '/vault/notes/report.md',
    ]);
  });

  it('never runs Pandoc without the sandbox', () => {
    for (const target of EXPORT_TARGETS.filter(needsPandoc)) {
      expect(exportArguments('/a.json', '/b', target)[0]).toBe('--sandbox');
    }
    expect(readArguments('/a.md')[0]).toBe('--sandbox');
  });

  it('no longer points Pandoc at the note\'s folder for pictures', () => {
    // Every picture it may carry is already inside the document as data.
    expect(exportArguments('/a.json', '/b.docx', 'docx')).not.toContain('--resource-path');
  });

  it('puts both filenames behind the end-of-options marker', () => {
    const args = exportArguments('/vault/--version.json', '/out/x.rtf', 'rtf');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('/vault/--version.json');
    const read = readArguments('/vault/--version.md');
    expect(read.slice(-2)).toEqual(['--', '/vault/--version.md']);
  });

  it('refuses to build arguments for a target it does not convert', () => {
    expect(() => exportArguments('/a.json', '/b.pdf', 'pdf')).toThrow(/EXPORT_NOT_PANDOC/);
  });
});

describe('exportThroughPandoc', () => {
  const never = async () => { throw new Error('should not have run'); };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  /** A note whose only picture is the one given. */
  const astWith = (url: string) => JSON.stringify({
    'pandoc-api-version': [1, 23, 1],
    meta: {},
    blocks: [{ t: 'Para', c: [{ t: 'Image', c: [['', [], []], [], [url, '']] }] }],
  });
  /** Answers the read with the given document and records every run. */
  const pandoc = (ast = astWith('data:image/png;base64,AA'), fail?: Error) => {
    const runs: string[][] = [];
    const staged: string[] = [];
    const run = async (_binary: string, args: readonly string[]) => {
      runs.push([...args]);
      if (args.includes('gfm')) return ast;
      staged.push(readFileSync(args[args.length - 1], 'utf8'));
      if (fail) throw fail;
      return '';
    };
    return { run, runs, staged };
  };
  const images = (files: Record<string, Uint8Array> = {}, remoteImages = false) => ({
    roots: ['/vault'],
    remoteImages,
    resolve: async (absolute: string) => (absolute in files ? absolute : null),
    exists: async (absolute: string) => absolute in files,
    read: async (absolute: string) => files[absolute],
  });

  it('refuses a note with unsaved changes, rather than exporting the old version', () => {
    // The kind of wrong nobody notices until after they have sent it on.
    return expect(exportThroughPandoc('docx', {
      notePath: '/vault/a.md', dirty: true, choose: never, findPandoc: never, run: never, images: images(),
    })).resolves.toEqual({ exported: false, reason: 'unsaved' });
  });

  it('refuses with nothing open', async () => {
    expect(await exportThroughPandoc('docx', {
      notePath: null, dirty: false, choose: never, findPandoc: never, run: never, images: images(),
    })).toEqual({ exported: false, reason: 'no-document' });
  });

  it('is quiet when the reader dismisses the dialog, and runs nothing', async () => {
    expect(await exportThroughPandoc('docx', {
      notePath: '/vault/a.md', dirty: false, choose: async () => null, findPandoc: never, run: never, images: images(),
    })).toEqual({ exported: false, reason: 'cancelled' });
  });

  it('says when Pandoc is missing', async () => {
    expect(await exportThroughPandoc('epub', {
      notePath: '/vault/a.md',
      dirty: false,
      choose: async () => '/out/a.epub',
      findPandoc: async () => null,
      run: never,
      images: images(),
    })).toEqual({ exported: false, reason: 'no-pandoc' });
  });

  it('offers the note name and reports where it went', async () => {
    let offered = '';
    const { run, runs } = pandoc();
    const outcome = await exportThroughPandoc('docx', {
      notePath: '/vault/Report.md',
      dirty: false,
      choose: async (suggested) => { offered = suggested; return '/out/Report.docx'; },
      findPandoc: async () => '/p',
      run,
      images: images(),
    });
    expect(offered).toBe('Report.docx');
    expect(outcome).toEqual({ exported: true, path: '/out/Report.docx' });
    expect(runs.every((args) => args[0] === '--sandbox')).toBe(true);
  });

  it('carries a picture from inside the folder as data, and cleans up after itself', async () => {
    const { run, runs, staged } = pandoc(astWith('assets/a.png'));
    const outcome = await exportThroughPandoc('docx', {
      notePath: '/vault/a.md',
      dirty: false,
      choose: async () => '/out/a.docx',
      findPandoc: async () => '/p',
      run,
      images: images({ '/vault/assets/a.png': PNG }),
    });
    expect(outcome).toEqual({ exported: true, path: '/out/a.docx' });
    expect(staged[0]).toContain(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    expect(staged[0]).not.toContain('assets/a.png');
    const stagedPath = runs[1][runs[1].length - 1];
    expect(existsSync(stagedPath)).toBe(false);
  });

  it('refuses a note naming a file outside the folder, and lists it', async () => {
    const { run, runs } = pandoc(astWith('/Users/me/.ssh/id.png'));
    const outcome = await exportThroughPandoc('docx', {
      notePath: '/vault/a.md',
      dirty: false,
      choose: async () => '/out/a.docx',
      findPandoc: async () => '/p',
      run,
      images: images(),
    });
    expect(outcome).toMatchObject({ exported: false, reason: 'unsafe-images' });
    expect(outcome.exported === false && outcome.detail).toContain('/Users/me/.ssh/id.png');
    // Read, judged, and never converted.
    expect(runs).toHaveLength(1);
  });

  it('refuses a web picture while remote images are off', async () => {
    const { run } = pandoc(astWith('https://tracker.example/p.png'));
    const outcome = await exportThroughPandoc('epub', {
      notePath: '/vault/a.md', dirty: false, choose: async () => '/out/a.epub',
      findPandoc: async () => '/p', run, images: images({}, false),
    });
    expect(outcome).toMatchObject({ exported: false, reason: 'unsafe-images' });
  });

  it('says when this Pandoc cannot run sandboxed', async () => {
    // A distribution build keeps its templates on disk, which the sandbox
    // cannot read; running it unsandboxed instead would undo the point.
    const { run } = pandoc(undefined, new Error('Could not find data file data/data/docx/[Content_Types].xml'));
    const outcome = await exportThroughPandoc('docx', {
      notePath: '/vault/a.md', dirty: false, choose: async () => '/out/a.docx',
      findPandoc: async () => '/p', run, images: images(),
    });
    expect(outcome).toMatchObject({ exported: false, reason: 'pandoc-sandbox' });
  });

  it('reports what Pandoc said when it failed', async () => {
    const { run } = pandoc(undefined, new Error('pandoc: cannot produce epub'));
    const outcome = await exportThroughPandoc('epub', {
      notePath: '/vault/a.md',
      dirty: false,
      choose: async () => '/out/a.epub',
      findPandoc: async () => '/p',
      run,
      images: images(),
    });
    expect(outcome).toMatchObject({ exported: false, reason: 'failed' });
    expect(outcome.exported === false && outcome.detail).toContain('cannot produce epub');
  });
});

describe('standaloneHtml', () => {
  it('is a whole page with the styles written into it', () => {
    // An exported file that needs a second file to look right is not one you
    // can send to anybody.
    const page = standaloneHtml({ title: 'Report', body: '<h1>Report</h1>', styled: true });
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<title>Report</title>');
    expect(page).toContain('<style>');
    expect(page).toContain('<h1>Report</h1>');
    expect(page).toContain('@media print');
  });

  it('leaves the styles out when asked, which is Typora\'s plain HTML', () => {
    const page = standaloneHtml({ title: 'Report', body: '<h1>Report</h1>', styled: false });
    expect(page).not.toContain('<style>');
    expect(page).toContain('<h1>Report</h1>');
  });

  it('escapes the title, which comes from a filename', () => {
    const page = standaloneHtml({ title: '<script>alert(1)</script>', body: '', styled: false });
    expect(page).toContain('&lt;script&gt;');
    expect(page).not.toContain('<script>alert');
  });

  it('escapes the five characters that can end an element or an attribute', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});

describe('the palette and the menu share one list', () => {
  it('offers every export target, under the File source', () => {
    expect(EXPORT_PALETTE_COMMANDS.map((item) => item.target)).toEqual([...EXPORT_TARGETS]);
    for (const item of EXPORT_PALETTE_COMMANDS) {
      expect(item.source).toBe('File');
      expect(item.title).toBe(`Export ${exportShape(item.target).label}…`);
    }
  });

  it('keeps the shapes the menu already uses in shared, not a second copy', () => {
    for (const kind of EXPORT_KINDS) {
      expect(EXPORT_TARGET_SHAPES[kind]).toEqual(exportShape(kind));
    }
  });
});

describe('the exported stylesheet', () => {
  it('carries callouts and diagrams, which the vault actually uses', () => {
    const page = standaloneHtml({ title: 'x', body: '<div class="noto-alert"></div>', styled: true });
    expect(page).toContain('.noto-alert');
    expect(page).toContain('.noto-alert-note');
    expect(page).toContain('.noto-diagram svg');
    expect(page).toContain('break-inside: avoid');
  });
});
