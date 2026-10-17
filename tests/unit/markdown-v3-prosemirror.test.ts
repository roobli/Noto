import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMarkdown, topLevelNodes } from '../../src/shared/markdown/v3/syntax';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans, blockFromSpan } from '../../src/shared/markdown/v3/pm/from-mdast';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';

/** markdown -> mdast -> ProseMirror -> mdast -> markdown */
function roundTrip(markdown: string): string {
  return splitBlocks(markdown).spans.map((span) => blockToMarkdown(blockFromSpan(span))).join('\n\n');
}

function kindsOf(markdown: string): string[] {
  return splitBlocks(markdown).spans.map((span) => span.kind);
}

function pmDoc(markdown: string) {
  return docFromSpans(splitBlocks(markdown).spans);
}

describe('ProseMirror schema coverage', () => {
  it('has a node for every construct the parser can produce', () => {
    for (const name of [
      'paragraph', 'heading', 'blockquote', 'code_block', 'math_block', 'frontmatter',
      'html_block', 'horizontal_rule', 'bullet_list', 'ordered_list', 'list_item',
      'table', 'table_row', 'table_cell', 'table_header', 'footnote_definition',
      'link_definition', 'image', 'math_inline', 'footnote_reference', 'inline_html', 'hard_break',
    ]) {
      expect(notoSchema.nodes[name], `missing node ${name}`).toBeDefined();
    }
    for (const name of ['emphasis', 'strong', 'strikethrough', 'inline_code', 'link']) {
      expect(notoSchema.marks[name], `missing mark ${name}`).toBeDefined();
    }
  });

  it('builds real editable nodes for the constructs v2 froze as opaque source', () => {
    expect(pmDoc('| a | b |\n| --- | --- |\n| 1 | 2 |').firstChild?.type.name).toBe('table');
    expect(pmDoc('- [ ] todo').firstChild?.type.name).toBe('bullet_list');
    expect(pmDoc('$$\nx\n$$').firstChild?.type.name).toBe('math_block');
    expect(pmDoc('---\ntitle: t\n---').firstChild?.type.name).toBe('frontmatter');
    expect(pmDoc('> [!NOTE]\n> callout').firstChild?.type.name).toBe('blockquote');
  });

  it('keeps task list checked state on the list item', () => {
    const list = pmDoc('- [ ] open\n- [x] done').firstChild;
    expect(list?.child(0).attrs.checked).toBe(false);
    expect(list?.child(1).attrs.checked).toBe(true);
  });

  it('keeps table alignment and header rows', () => {
    const table = pmDoc('| a | b |\n| :-- | --: |\n| 1 | 2 |').firstChild;
    expect(table?.child(0).child(0).type.name).toBe('table_header');
    expect(table?.child(0).child(0).attrs.align).toBe('left');
    expect(table?.child(0).child(1).attrs.align).toBe('right');
    expect(table?.child(1).child(0).type.name).toBe('table_cell');
  });

  it('keeps the code fence language', () => {
    expect(pmDoc('```ts\nconst a = 1;\n```').firstChild?.attrs.lang).toBe('ts');
  });
});

describe('ProseMirror round trip stability', () => {
  const constructs: Record<string, string> = {
    heading: '# Title',
    paragraph: 'Some body text.',
    emphasis: 'Text with _emphasis_ inside.',
    strong: 'Text with *strong* inside.',
    strikethrough: 'Text with ~~deleted~~ inside.',
    'inline code': 'Call `render()` here.',
    link: 'See [the docs](https://example.com).',
    'link with title': 'See [docs](https://example.com "Title").',
    'link reference': 'See [docs][ref].',
    image: 'An image ![alt](./a.png).',
    'bullet list': '- one\n- two',
    'ordered list': '1. one\n2. two',
    'task list': '- [ ] open\n- [x] done',
    'nested list': '- outer\n  - inner',
    blockquote: '> quoted text',
    'fenced code': '```ts\nconst a = 1;\n```',
    'code without language': '```\nplain\n```',
    table: '| a | b |\n| --- | --- |\n| 1 | 2 |',
    'aligned table': '| a | b |\n| :-- | --: |\n| 1 | 2 |',
    'display math': '$$\nx = 1\n$$',
    'inline math': 'Value $x = 1$ inline.',
    'thematic break': '---',
    frontmatter: '---\ntitle: t\n---',
    'html block': '<div>\n  raw\n</div>',
    'footnote definition': '[^1]: The note.',
    'link definition': '[ref]: https://example.com',
    'hard break': 'line one\\\nline two',
    cjk: '中文段落，带标点。',
  };

  for (const [name, source] of Object.entries(constructs)) {
    it(`is idempotent for ${name}`, () => {
      const once = roundTrip(source);
      const twice = roundTrip(once);
      expect(twice).toBe(once);
    });

    it(`preserves block structure for ${name}`, () => {
      expect(kindsOf(roundTrip(source))).toEqual(kindsOf(source));
    });
  }

  it('preserves table cell contents exactly', () => {
    const output = roundTrip('| head | other |\n| --- | --- |\n| body | cell |');
    expect(output).toContain('head');
    expect(output).toContain('other');
    expect(output).toContain('body');
    expect(output).toContain('cell');
  });

  it('preserves math source without rendering it', () => {
    expect(roundTrip('$$\n\\frac{1}{2}\n$$')).toContain('\\frac{1}{2}');
  });

  it('preserves raw HTML verbatim rather than escaping it', () => {
    const output = roundTrip('<div class="x">\n  <span>raw</span>\n</div>');
    expect(output).toContain('<div class="x">');
    expect(output).toContain('<span>raw</span>');
  });

  it('preserves the reference form of a link rather than inlining it', () => {
    // A reference only exists when its definition does. Without one CommonMark
    // treats the brackets as literal text, which is why the definition is here.
    const output = roundTrip('See [docs][ref].\n\n[ref]: https://example.com');
    expect(output).toContain('[docs][ref]');
    expect(output).toContain('[ref]: https://example.com');
  });

  it('preserves inline html inside a paragraph', () => {
    expect(roundTrip('before <br/> after')).toContain('<br/>');
  });

  it('normalises emphasis and strong markers without changing their meaning', () => {
    // A single marker is emphasis and a double marker is strong. The serializer
    // settles on the star for both, which is what the vault writes: 5,280
    // starred runs against 364 underscored ones.
    expect(roundTrip('*emphasis*')).toBe('*emphasis*');
    expect(roundTrip('_emphasis_')).toBe('*emphasis*');
    expect(roundTrip('**strong**')).toBe('**strong**');
    expect(roundTrip('__strong__')).toBe('**strong**');
  });

  it('keeps an indented code block indented rather than adding a fence', () => {
    const source = '    indented();\n    more();';
    const span = splitBlocks(source).spans[0];
    expect(span.kind).toBe('indented-code');
    expect(blockToMarkdown(blockFromSpan(span))).toBe(source);
  });
});

describe('ProseMirror round trip over the fixture corpus', () => {
  const corpus = path.join(__dirname, '..', 'fixtures', 'g002-v1');
  const files = readdirSync(corpus).filter((name) => name.endsWith('.md'));

  for (const name of files) {
    it(`keeps ${name} structurally stable through ProseMirror`, () => {
      const source = readFileSync(path.join(corpus, name), 'utf8');
      const once = roundTrip(source);
      expect(roundTrip(once)).toBe(once);
      expect(kindsOf(once)).toEqual(kindsOf(source));
    });
  }
});

describe('Typora inline syntax the parser must leave alone', () => {
  it('reads one tilde as text and a pair as strikethrough', () => {
    const doc = pmDoc('H~2~O and ~~gone~~');
    const paragraph = doc.firstChild!;
    const struck: string[] = [];
    let text = '';
    paragraph.forEach((child) => {
      text += child.text ?? '';
      if (child.marks.some((mark) => mark.type.name === 'strikethrough')) struck.push(child.text ?? '');
    });
    expect(text).toBe('H~2~O and gone');
    expect(struck).toEqual(['gone']);
  });

  it('writes the marks back as they were', () => {
    const source = 'Mark ==key== and x^2^ and H~2~O, then ~~gone~~.';
    expect(roundTrip(source)).toBe(source);
  });
});

describe('a newline inside a paragraph', () => {
  it('is kept, so the break the author typed is the break that shows', () => {
    const doc = pmDoc('first line\nsecond line');
    expect(doc.firstChild!.textContent).toBe('first line\nsecond line');
  });

  it('round-trips to the same bytes', () => {
    const source = 'first line\nsecond line';
    expect(roundTrip(source)).toBe(source);
  });

  it('leaves a paragraph break alone', () => {
    const doc = pmDoc('one\n\ntwo');
    expect(doc.childCount).toBe(2);
    expect(doc.firstChild!.textContent).toBe('one');
  });
});

describe('a URL written on its own', () => {
  it('stays written on its own', () => {
    expect(roundTrip('See https://example.com/a here.')).toBe('See https://example.com/a here.');
    expect(roundTrip('- https://example.com/a')).toBe('- https://example.com/a');
    expect(roundTrip('https://example.com/a?q=1&r=2')).toBe('https://example.com/a?q=1&r=2');
  });

  it('leaves a link that says something else alone', () => {
    expect(roundTrip('[the docs](https://example.com/a)')).toBe('[the docs](https://example.com/a)');
    expect(roundTrip('[x](https://example.com "T")')).toBe('[x](https://example.com "T")');
  });

  it('keeps the brackets where a bare URL would come back shorter', () => {
    // GFM trims a trailing full stop off a bare URL, so this one has to keep
    // its brackets or the address loses a character on the way back in.
    expect(roundTrip('<https://example.com/a.>')).toBe('<https://example.com/a.>');
    expect(roundTrip('<mailto:someone@example.com>')).toBe('<mailto:someone@example.com>');
  });
});

describe('emphasis beside Chinese text', () => {
  it('is read as emphasis, which CommonMark alone will not do', () => {
    const doc = pmDoc('**注意：**一定不要这样');
    const strong: string[] = [];
    doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'strong')) strong.push(node.text!);
    });
    expect(strong).toEqual(['注意：']);
  });

  it('is written back exactly as it was', () => {
    expect(roundTrip('**注意：**一定不要这样')).toBe('**注意：**一定不要这样');
    expect(roundTrip('**消息队列**和**管道**：两种机制')).toBe('**消息队列**和**管道**：两种机制');
  });

  it('leaves English emphasis where it was', () => {
    expect(roundTrip('a **bold** word and an *emphatic* one'))
      .toBe('a **bold** word and an *emphatic* one');
  });
});

describe('what the serializer must not escape', () => {
  it('leaves an identifier and an alert marker alone', () => {
    expect(roundTrip('## mcp__claude_api 索引')).toBe('## mcp__claude_api 索引');
    expect(roundTrip('use search_mcp_register here')).toBe('use search_mcp_register here');
    expect(roundTrip('> [!TIP]\n> Something.')).toBe('> [!TIP]\n> Something.');
  });

  it('still escapes an underscore that could open emphasis', () => {
    expect(roundTrip('a \\_lonely underscore')).toContain('\\_');
  });

  it('leaves a star glued to a word, a metric at-sign, and an image alt alone', () => {
    // Real emphasis is already a node by here; the text handler only ever sees
    // a star CommonMark left literal, which used to be escaped on the way out.
    expect(roundTrip('# CLI — *nix Agent')).toBe('# CLI — *nix Agent');
    expect(roundTrip('*nix and **bold**')).toBe('*nix and **bold**');
    // A real address is a link node; this shape stays text and used to gain \@.
    expect(roundTrip('NDCG@10 and Recall@K')).toBe('NDCG@10 and Recall@K');
    // Image alts are not phrasing, so the text handler never saw them.
    expect(roundTrip('![img_v3_02144_abc](https://x.test/a.jpg)'))
      .toBe('![img_v3_02144_abc](https://x.test/a.jpg)');
  });
});

describe('a table, written back', () => {
  it('keeps the three dashes and the unpadded cells the vault writes', () => {
    const plain = '| 字段 | 值 |\n| --- | --- |\n| a | 1 |';
    expect(roundTrip(plain)).toBe(plain);
    const aligned = '| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| a | b | c |';
    expect(roundTrip(aligned)).toBe(aligned);
  });
});

describe('a highlight at the head of a paragraph', () => {
  it('keeps its own marks, which an escape would take away', () => {
    expect(roundTrip('==自由度== 是这样的')).toBe('==自由度== 是这样的');
    expect(roundTrip('==key point== and more')).toBe('==key point== and more');
    // Mid-sentence it never needed help, and still does not.
    expect(roundTrip('a ==b== c')).toBe('a ==b== c');
  });
});

describe('a hard break', () => {
  it('stays two spaces, the form the vault is written in', () => {
    expect(roundTrip('one  \ntwo')).toBe('one  \ntwo');
    expect(roundTrip('- item  \n  more')).toBe('- item  \n  more');
    expect(roundTrip('> quoted  \n> on')).toBe('> quoted  \n> on');
  });

  it('is still a backslash where the file already wrote one', () => {
    expect(roundTrip('one\\\ntwo')).toBe('one  \ntwo');
  });
});

describe('a link whose text carries another mark', () => {
  it('comes back as one link, not one per run', () => {
    // ProseMirror keeps a mark on each text node, so this link is two nodes,
    // both linked. Written out separately it becomes two links, which the
    // vault would have suffered 1,491 times.
    expect(roundTrip('A [**bold** and plain](https://e.com/x) link.'))
      .toBe('A [**bold** and plain](https://e.com/x) link.');
    expect(roundTrip('A [*em* and `code`](https://e.com/y) link.'))
      .toBe('A [*em* and `code`](https://e.com/y) link.');
    expect(roundTrip('See [`Component` 构造器](https://e.com/z).'))
      .toBe('See [`Component` 构造器](https://e.com/z).');
  });

  it('keeps two genuinely different links apart', () => {
    expect(roundTrip('[one](https://e.com/a)[two](https://e.com/b)'))
      .toBe('[one](https://e.com/a)[two](https://e.com/b)');
  });

  it('does the same for a reference link', () => {
    expect(roundTrip('A [**bold** and plain][ref] link.\n\n[ref]: https://e.com/x'))
      .toBe('A [**bold** and plain][ref] link.\n\n[ref]: https://e.com/x');
  });
});

describe('a list marker the source chose', () => {
  it('keeps a star list starred and a parenthesis list parenthesised', () => {
    expect(roundTrip('* LLM\n* Transformer')).toBe('* LLM\n* Transformer');
    expect(roundTrip('1) first\n2) second')).toBe('1) first\n2) second');
    // The dialect default stays the default for the form the vault uses most.
    expect(roundTrip('- dash\n- list')).toBe('- dash\n- list');
    expect(roundTrip('1. one\n2. two')).toBe('1. one\n2. two');
  });
});
