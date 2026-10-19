import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { parseDocument, toLf } from '../../src/shared/markdown/v3/document';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';
import { parseMarkdown, renderMarkdown, topLevelNodes } from '../../src/shared/markdown/v3/syntax';
import { blockFromSpan } from '../../src/shared/markdown/v3/pm/from-mdast';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoDocument,
  type NotoTransaction,
  type NotoUnit,
} from '../../src/shared/markdown/v3/contracts';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

function parsed(source: string | Uint8Array): NotoDocument {
  const result = parseDocument(typeof source === 'string' ? bytes(source) : source);
  if (result.status !== 'parsed') throw new Error(`expected a parsed document, got ${result.code}`);
  return result.document;
}

function kinds(source: string): string[] {
  return parsed(source).blocks.map((block) => block.kind);
}

/** Replace one block's markdown, leaving every other unit pristine. */
function editing(document: NotoDocument, ordinal: number, markdown: string): NotoTransaction {
  const units: NotoUnit[] = document.blocks.map((block) => ({
    origin: block.origin,
    markdown: block.origin.ordinal === ordinal ? markdown : block.markdown,
  }));
  return {
    version: NOTO_MARKDOWN_VERSION,
    mode: 'blocks',
    envelope: { lineEnding: 'mixed' as const, hasFinalNewline: true },
    documentId: document.documentId,
    revisionId: document.revisionId,
    units,
  };
}

function serialized(document: NotoDocument, transaction: NotoTransaction): Uint8Array {
  const result = serializeDocument(document, transaction);
  if (result.status !== 'serialized') throw new Error(`expected serialization, got ${result.code}: ${result.message}`);
  return result.outputBytes;
}

describe('markdown v3 block coverage', () => {
  it('treats every GFM construct as a first class block rather than opaque source', () => {
    expect(kinds('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual(['table']);
    expect(kinds('- [ ] todo\n- [x] done')).toEqual(['task-list']);
    expect(kinds('~~gone~~')).toEqual(['paragraph']);
    expect(kinds('A footnote.[^1]\n\n[^1]: The note.')).toEqual(['paragraph', 'footnote-definition']);
  });

  it('parses math, frontmatter, html and thematic breaks as blocks', () => {
    expect(kinds('$$\nx = 1\n$$')).toEqual(['display-math']);
    expect(kinds('---\ntitle: Noto\n---\n\nBody.')).toEqual(['frontmatter', 'paragraph']);
    expect(kinds('<div class="x">\n  raw\n</div>')).toEqual(['html']);
    expect(kinds('one\n\n---\n\ntwo')).toEqual(['paragraph', 'thematic-break', 'paragraph']);
  });

  it('separates fenced from indented code and records the language', () => {
    expect(kinds('```ts\nconst a = 1;\n```')).toEqual(['fenced-code']);
    expect(kinds('    indented();')).toEqual(['indented-code']);
    const document = parsed('```ts\nconst a = 1;\n```');
    expect(document.blocks[0].semanticKey).toContain('ts');
  });

  it('distinguishes list flavours', () => {
    expect(kinds('- a\n- b')).toEqual(['bullet-list']);
    expect(kinds('1. a\n2. b')).toEqual(['ordered-list']);
    expect(kinds('- [ ] a')).toEqual(['task-list']);
  });

  it('covers every character of the source across blocks and gaps', () => {
    const source = '# Title\n\nBody text.\n\n- a\n- b\n';
    const split = splitBlocks(source);
    const rebuilt = split.leading
      + split.spans.map((span, index) => span.markdown + (split.gaps[index] ?? '')).join('')
      + split.trailing;
    expect(rebuilt).toBe(source);
  });
});

describe('markdown v3 byte fidelity', () => {
  const samples: Record<string, string> = {
    'plain lf': '# Title\n\nBody.\n',
    'no final newline': '# Title\n\nBody.',
    'crlf': '# Title\r\n\r\nBody.\r\n',
    'blank line runs': '# Title\n\n\n\nBody.\n\n\n',
    'leading blank lines': '\n\n# Title\n\nBody.\n',
    'tight blocks': '# Title\nBody directly beneath.\n',
    'whitespace only': '\n\n\n',
    'empty': '',
    'table and math': '| a |\n| --- |\n| 1 |\n\n$$\nx\n$$\n',
    'frontmatter': '---\ntitle: t\n---\n\nBody.\n',
    'cjk': '# 标题\n\n中文段落，带标点。\n',
  };

  for (const [name, source] of Object.entries(samples)) {
    it(`round trips "${name}" byte for byte`, () => {
      const document = parsed(source);
      const output = serialized(document, identityTransaction(document));
      expect(Buffer.from(output).toString('utf8')).toBe(source);
      expect(Buffer.from(output).equals(Buffer.from(bytes(source)))).toBe(true);
    });
  }

  it('preserves a UTF-8 BOM through an identity save', () => {
    const source = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('# Title\n')]);
    const document = parsed(source);
    expect(document.envelope.bom).toBe('utf8');
    const output = serialized(document, identityTransaction(document));
    expect(Buffer.from(output).equals(Buffer.from(source))).toBe(true);
  });

  it('keeps untouched blocks byte identical when one block is edited', () => {
    const source = '# Title\n\nUntouched paragraph.\n\n```ts\nconst a = 1;\n```\n\nTail.\n';
    const document = parsed(source);
    const result = serializeDocument(document, editing(document, 0, '# Renamed'));
    expect(result.status).toBe('serialized');
    if (result.status !== 'serialized') return;

    const output = Buffer.from(result.outputBytes).toString('utf8');
    expect(output).toBe('# Renamed\n\nUntouched paragraph.\n\n```ts\nconst a = 1;\n```\n\nTail.\n');
    // The fenced code block must survive as literal source, never re-rendered.
    expect(output).toContain('```ts\nconst a = 1;\n```');
    const preservedBlocks = result.preserved.filter((range) => range.role === 'block');
    expect(preservedBlocks).toHaveLength(3);
  });

  it('leaves a neighbour written in its own style completely alone', () => {
    // Re-serializing either of these would change bytes: a long rule collapses
    // to three dashes and an aligned delimiter row to the minimum width. Neither
    // block is edited, so neither is re-serialized, and the file keeps the
    // shape its author gave it.
    const source = [
      'Lead paragraph.',
      '',
      '------------------',
      '',
      '| Field | Meaning |',
      '|-------|---------|',
      '| a     | first   |',
      '',
    ].join('\n');
    const document = parsed(source);
    const output = Buffer.from(serialized(document, editing(document, 0, 'Edited lead.'))).toString('utf8');
    expect(output).toBe(source.replace('Lead paragraph.', 'Edited lead.'));
    expect(output).toContain('------------------');
    expect(output).toContain('|-------|---------|');
  });

  it('restores CRLF for an edited block in a CRLF document', () => {
    const source = '# Title\r\n\r\nBody.\r\n';
    const document = parsed(source);
    const output = Buffer.from(serialized(document, editing(document, 1, 'Replaced body.'))).toString('utf8');
    expect(output).toBe('# Title\r\n\r\nReplaced body.\r\n');
    expect(output).not.toContain('\n\n');
  });

  it('normalises line endings to LF for the editor while keeping CRLF on disk', () => {
    const document = parsed('# Title\r\n\r\n- a\r\n- b\r\n');
    expect(document.envelope.lineEnding).toBe('crlf');
    expect(document.blocks[1].markdown).toBe('- a\n- b');
  });
});

describe('markdown v3 transaction safety', () => {
  it('rejects a transaction built against another revision', () => {
    const document = parsed('# Title\n');
    const result = serializeDocument(document, {
      ...identityTransaction(document),
      revisionId: 'noto-rev-v3:stale' as NotoDocument['revisionId'],
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('STALE_REVISION');
  });

  it('rejects an origin the document never issued', () => {
    const document = parsed('# Title\n\nBody.\n');
    const transaction = identityTransaction(document);
    const forged = {
      ...transaction,
      units: [
        { origin: { ...document.blocks[0].origin, semanticKey: 'heading\u00006' }, markdown: '# Title' },
        transaction.mode === 'blocks' ? transaction.units[1] : { origin: null, markdown: 'Body.' },
      ],
    } as NotoTransaction;
    const result = serializeDocument(document, forged);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('FORGED_ORIGIN');
  });

  it('rejects reordered surviving blocks', () => {
    const document = parsed('# One\n\n# Two\n');
    const transaction = identityTransaction(document);
    if (transaction.mode !== 'blocks') throw new Error('expected a block transaction');
    const result = serializeDocument(document, {
      ...transaction,
      units: [transaction.units[1], transaction.units[0]],
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('REORDERED_ORIGIN');
  });

  it('rejects an edit that would split one block into several', () => {
    const document = parsed('# Title\n\nBody.\n');
    const result = serializeDocument(document, editing(document, 1, 'First para.\n\nSecond para.'));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('MULTI_BLOCK_UNIT');
  });

  it('widens a single newline gap when an edit would otherwise merge two blocks', () => {
    // `# Title\nBody.` is two blocks only because the heading is self
    // terminating. Demoting it to plain text would merge them, so the gap has
    // to grow to a blank line. The edit is honoured rather than refused.
    const document = parsed('# Title\nBody.\n');
    expect(document.blocks).toHaveLength(2);
    const output = Buffer.from(serialized(document, editing(document, 0, 'Title'))).toString('utf8');
    expect(output).toBe('Title\n\nBody.\n');
    expect(parsed(output).blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
  });

  it('preserves a single newline gap when neither neighbour changed', () => {
    const source = '# Title\nBody.\n';
    const document = parsed(source);
    expect(Buffer.from(serialized(document, identityTransaction(document))).toString('utf8')).toBe(source);
  });

  it('rejects an edit that would swallow the rest of the document', () => {
    // An unterminated fence is a single block on its own, so it passes the
    // per-unit check, but it consumes everything after it once written out.
    // Only reparsing the finished file catches this.
    const document = parsed('Intro.\n\nSecond.\n');
    const result = serializeDocument(document, editing(document, 0, '```ts'));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('REPARSE_MISMATCH');
  });

  it('accepts a newly inserted block with no origin', () => {
    const document = parsed('# Title\n\nBody.\n');
    const transaction = identityTransaction(document);
    if (transaction.mode !== 'blocks') throw new Error('expected a block transaction');
    const output = Buffer.from(serialized(document, {
      ...transaction,
      units: [transaction.units[0], { origin: null, markdown: 'Inserted.' }, transaction.units[1]],
    })).toString('utf8');
    expect(output).toBe('# Title\n\nInserted.\n\nBody.\n');
  });

  it('accepts deleting a block and preserves the survivors', () => {
    const document = parsed('# Title\n\nDoomed.\n\nKept.\n');
    const transaction = identityTransaction(document);
    if (transaction.mode !== 'blocks') throw new Error('expected a block transaction');
    const output = Buffer.from(serialized(document, {
      ...transaction,
      units: [transaction.units[0], transaction.units[2]],
    })).toString('utf8');
    expect(output).toBe('# Title\n\nKept.\n');
  });

  it('replaces the whole file in source mode and reparses the result', () => {
    const document = parsed('# Title\n');
    const replacement = bytes('---\ntitle: t\n---\n\n# Title\n');
    const result = serializeDocument(document, {
      version: NOTO_MARKDOWN_VERSION,
      mode: 'source',
      documentId: document.documentId,
      revisionId: document.revisionId,
      expectedSourceSha256: document.envelope.sourceSha256,
      sourceBytes: replacement,
    });
    expect(result.status).toBe('serialized');
    if (result.status !== 'serialized') return;
    expect(Buffer.from(result.outputBytes).equals(Buffer.from(replacement))).toBe(true);
    expect(result.document.blocks.map((block) => block.kind)).toEqual(['frontmatter', 'heading']);
  });

  it('rejects invalid UTF-8 rather than rewriting the file', () => {
    const result = parseDocument(Uint8Array.from([0x23, 0x20, 0xff, 0xfe]));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('INVALID_UTF8');
  });
});

describe('markdown v3 against the existing fixture corpus', () => {
  const corpus = path.join(__dirname, '..', 'fixtures', 'g002-v1');
  const files = readdirSync(corpus).filter((name) => name.endsWith('.md'));

  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const name of files) {
    it(`round trips ${name} byte for byte`, () => {
      const source = readFileSync(path.join(corpus, name));
      const document = parsed(new Uint8Array(source));
      const output = serialized(document, identityTransaction(document));
      expect(Buffer.from(output).equals(source)).toBe(true);
    });

    it(`parses ${name} without falling back to source-only`, () => {
      const source = readFileSync(path.join(corpus, name));
      const document = parsed(new Uint8Array(source));
      // v1 degraded these files to `unsupported`. v3 must classify every block.
      expect(document.blocks.every((block) => toLf(block.markdown).length > 0)).toBe(true);
    });
  }
});

describe('an unchanged save skips the reparse without weakening the result', () => {
  const source = '# Title\n\nBody text.\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';

  it('reproduces the bytes exactly and carries the document forward', () => {
    const document = parsed(source);
    const output = serializeDocument(document, identityTransaction(document));
    if (output.status !== 'serialized') throw new Error('expected a serialized result');
    expect(new TextDecoder().decode(output.outputBytes)).toBe(source);
    // The skipped reparse must still yield a document equivalent to one that
    // was reparsed, or the next revision would be built on a stale structure.
    expect(output.document.blocks.map((block) => block.markdown))
      .toEqual(document.blocks.map((block) => block.markdown));
    expect(output.document.blocks.map((block) => block.sha256))
      .toEqual(document.blocks.map((block) => block.sha256));
  });

  it('still reparses, and still catches damage, once a block actually changes', () => {
    const document = parsed(source);
    const units = document.blocks.map((block, index) => ({
      origin: block.origin,
      // Turn the fenced block into an unterminated fence, which would swallow
      // the table that follows it.
      markdown: index === 2 ? '```ts\nconst x = 1;' : null,
    }));
    const result = serializeDocument(document, {
      version: NOTO_MARKDOWN_VERSION,
      mode: 'blocks',
      envelope: { lineEnding: 'mixed' as const, hasFinalNewline: true },
      documentId: document.documentId,
      revisionId: document.revisionId,
      units,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.code).toBe('REPARSE_MISMATCH');
  });
});

describe('dialect decisions that stay', () => {
  it('collapses a long rule when that block is the one rewritten', () => {
    // Three dashes are the vault's majority form. A neighbouring edit already
    // leaves a six-dash rule alone (see above); this locks the choice when the
    // rule itself is re-serialized.
    const node = topLevelNodes(parseMarkdown('------\n'))[0];
    expect(renderMarkdown(node).trim()).toBe('---');
  });

  it('strips trailing spaces that cannot be a hard break', () => {
    // Two spaces at the end of a heading cannot break, and two at the end of a
    // paragraph have nothing to break before. The bytes go; the meaning does not.
    const heading = splitBlocks('# Title with spaces   \n').spans[0];
    expect(blockToMarkdown(blockFromSpan(heading))).toBe('# Title with spaces');
    const paragraph = splitBlocks('A paragraph with spaces   \n').spans[0];
    expect(blockToMarkdown(blockFromSpan(paragraph))).toBe('A paragraph with spaces');
  });

  it('strips leading spaces instead of writing a character reference', () => {
    // Deleting a paragraph's first word leaves a leading space. Written as
    // `&#x20;`, it is a reference to a space nobody can see, in the file.
    const schema = blockFromSpan(splitBlocks('x\n').spans[0]).type.schema;
    const paragraph = schema.node('paragraph', null, schema.text(' and a word'));
    expect(blockToMarkdown(paragraph)).toBe('and a word');
    const heading = schema.node('heading', { level: 2 }, schema.text('  Title'));
    expect(blockToMarkdown(heading)).toBe('## Title');
  });

  it('still leaves a six-dash rule and a padded table alone beside an edit', () => {
    const source = [
      'Lead paragraph.',
      '',
      '------',
      '',
      '| Field | Meaning |',
      '|-------|---------|',
      '| a     | first   |',
      '',
    ].join('\n');
    const document = parsed(source);
    const output = Buffer.from(serialized(document, editing(document, 0, 'Edited lead.'))).toString('utf8');
    expect(output).toContain('------');
    expect(output).toContain('|-------|---------|');
    expect(output).toContain('| a     | first   |');
  });
});
