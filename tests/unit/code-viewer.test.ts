import { describe, expect, it } from 'vitest';
import { isProbablyBinary } from '../../src/shared/code-viewer/binary';
import {
  isDrawioFileName,
  isDrawioSvgFileName,
  isHtmlMarkupFileName,
  isMarkdownFileName,
  isRenderableMarkupFileName,
  isSvgMarkupFileName,
  isViewableCodeFile,
  languageFor,
} from '../../src/shared/code-viewer/languages';
import { highlightCodeLines } from '../../src/renderer/code-viewer-highlight';
import { looksLikeSvgContent, markupPreviewKindFor } from '../../src/renderer/CodeViewer';
import { CODE_VIEW_MAX_BYTES, CODE_VIEW_MAX_LINES } from '../../src/shared/code-viewer/limits';

describe('recognising what to open', () => {
  it('maps common source extensions and special filenames', () => {
    expect(languageFor('/a/b/main.py')).toBe('python');
    expect(languageFor('server.ts')).toBe('typescript');
    expect(languageFor('app.tsx')).toBe('tsx');
    expect(languageFor('main.go')).toBe('go');
    expect(languageFor('lib.rs')).toBe('rust');
    expect(languageFor('data.yaml')).toBe('yaml');
    expect(languageFor('run.sh')).toBe('bash');
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('Makefile')).toBe('makefile');
    expect(languageFor('.gitignore')).toBe('gitignore');
  });

  it('refuses notes and known binaries, opens unknown text as plain', () => {
    expect(languageFor('README.md')).toBeNull();
    expect(languageFor('notes.txt')).toBeNull();
    expect(isMarkdownFileName('a/b/c.MD')).toBe(true);
    expect(isViewableCodeFile('photo.png')).toBe(false);
    expect(languageFor('notes.xyz')).toBe('');
    expect(isViewableCodeFile('notes.xyz')).toBe(true);
    expect(languageFor('SCRIPT.PY')).toBe('python');
  });
});

describe('binary detection', () => {
  it('treats a NUL or control-heavy sample as binary', () => {
    expect(isProbablyBinary('abc\0def')).toBe(true);
    expect(isProbablyBinary('def f():\n\treturn 1\n')).toBe(false);
    expect(isProbablyBinary('')).toBe(false);
    const junk = Array.from({ length: 100 }, (_, i) => String.fromCharCode((i % 8) + 1)).join('');
    expect(isProbablyBinary(junk)).toBe(true);
  });
});

describe('highlighting', () => {
  it('reconstructs the source exactly and colours a simple python line', () => {
    const source = 'def f():\n    return True  # yes\n';
    const lines = highlightCodeLines(source, 'python');
    expect(lines.map((line) => line.map((t) => t.text).join('')).join('\n')).toBe(source);
    const joined = lines[0]!.map((t) => t.text).join('');
    expect(joined).toBe('def f():');
  });

  it('leaves plain text uncoloured', () => {
    const lines = highlightCodeLines('just some text\n123 456', 'text');
    expect(lines.every((line) => line.every((t) => t.cls === null))).toBe(true);
  });
});

describe('limits', () => {
  it('keeps the author\'s preview caps', () => {
    expect(CODE_VIEW_MAX_BYTES).toBe(4_000_000);
    expect(CODE_VIEW_MAX_LINES).toBe(50_000);
  });
});

describe('drawio recognition', () => {
  it('opens .drawio as xml and .drawio.svg as markup', () => {
    expect(languageFor('arch.drawio')).toBe('xml');
    expect(isViewableCodeFile('arch.drawio')).toBe(true);
    expect(languageFor('arch.DRAWIO')).toBe('xml');
    expect(languageFor('flow.drawio.svg')).toBe('markup');
    expect(isViewableCodeFile('flow.drawio.svg')).toBe(true);
  });

  it('detects compound drawio.svg names separately from plain .drawio', () => {
    expect(isDrawioFileName('vault/a.drawio')).toBe(true);
    expect(isDrawioFileName('vault/a.drawio.svg')).toBe(false);
    expect(isDrawioSvgFileName('vault/a.drawio.svg')).toBe(true);
    expect(isDrawioSvgFileName('vault/a.svg')).toBe(false);
    expect(isDrawioSvgFileName('vault/a.drawio')).toBe(false);
  });

  it('accepts SVG heads for preview and rejects empty or non-svg', () => {
    expect(looksLikeSvgContent('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
    expect(looksLikeSvgContent('<svg viewBox="0 0 1 1"/>')).toBe(true);
    expect(looksLikeSvgContent('')).toBe(false);
    expect(looksLikeSvgContent('<mxfile host="app.diagrams.net"></mxfile>')).toBe(false);
  });
});

describe('html/svg markup preview recognition', () => {
  it('flags html/htm/xhtml/svg (incl. drawio.svg) as renderable markup', () => {
    expect(isRenderableMarkupFileName('page.html')).toBe(true);
    expect(isRenderableMarkupFileName('page.HTM')).toBe(true);
    expect(isRenderableMarkupFileName('page.xhtml')).toBe(true);
    expect(isRenderableMarkupFileName('icon.svg')).toBe(true);
    expect(isRenderableMarkupFileName('flow.drawio.svg')).toBe(true);
    expect(isRenderableMarkupFileName('arch.drawio')).toBe(false);
    expect(isRenderableMarkupFileName('main.py')).toBe(false);
    expect(isHtmlMarkupFileName('a/b/c.html')).toBe(true);
    expect(isHtmlMarkupFileName('icon.svg')).toBe(false);
    expect(isSvgMarkupFileName('icon.svg')).toBe(true);
    expect(isSvgMarkupFileName('flow.drawio.svg')).toBe(true);
    expect(isSvgMarkupFileName('page.html')).toBe(false);
  });

  it('defaults preview for svg/html and refuses when notice or non-svg body', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const html = '<!doctype html><title>x</title><p>hi</p>';
    expect(markupPreviewKindFor('a.svg', svg, null)).toBe('svg');
    expect(markupPreviewKindFor('a.drawio.svg', svg, null)).toBe('svg');
    expect(markupPreviewKindFor('a.html', html, null)).toBe('html');
    expect(markupPreviewKindFor('a.htm', html, null)).toBe('html');
    expect(markupPreviewKindFor('a.xhtml', html, null)).toBe('html');
    expect(markupPreviewKindFor('a.drawio', '<mxfile/>', null)).toBeNull();
    expect(markupPreviewKindFor('a.py', 'print(1)', null)).toBeNull();
    expect(markupPreviewKindFor('a.svg', '<mxfile/>', null)).toBeNull();
    expect(markupPreviewKindFor('a.html', html, 'too large')).toBeNull();
    expect(markupPreviewKindFor('a.html', '', null)).toBeNull();
  });
});
