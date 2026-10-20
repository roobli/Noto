/**
 * The single definition of which markdown dialect Noto speaks.
 *
 * Both the main process parser and the renderer's ProseMirror bridge import
 * from here, so a construct can never be editable on one side of the IPC
 * boundary and opaque on the other. Nothing in this module touches Node
 * builtins, because the renderer runs sandboxed without Node integration.
 */

import { fromMarkdown, type CompileContext, type Extension as FromMarkdownExtension, type Token } from 'mdast-util-from-markdown';
import { defaultHandlers, toMarkdown, type Handle, type Options as ToMarkdownOptions, type State } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly';
import { cjkFriendlyToMarkdown } from 'mdast-util-to-markdown-cjk-friendly';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter';
import type { Emphasis, Literal, Nodes, Parents, PhrasingContent, Root, RootContent } from 'mdast';

/**
 * A character reference, `&amp;` or `&#35;`, as one node of its own.
 *
 * `value` is the character it stands for and `source` is how the file wrote
 * it. See `characterReferencesAsNodes`.
 */
export interface CharacterReference extends Literal {
  type: 'characterReference';
  source: string;
}

declare module 'mdast' {
  interface PhrasingContentMap {
    characterReference: CharacterReference;
  }
  interface RootContentMap {
    characterReference: CharacterReference;
  }
}

// YAML only. TOML frontmatter has no mdast node type and no meaningful adoption
// in the editors Noto has to interoperate with.
const frontmatterSyntax = frontmatter();

const micromarkExtensions = [
  // One tilde is Typora's subscript, drawn in the editor; only a pair strikes.
  gfm({ singleTilde: false }),
  /*
   * Emphasis next to Chinese text.
   *
   * CommonMark decides whether `**` can close by what sits either side of it,
   * and it counts CJK punctuation as punctuation, so `**注意：**一定` does not
   * close and the whole run stays as literal asterisks. Typora closes it, and
   * so does anyone reading the file. A census of the vault found 596 of 3,220
   * bold runs unparsed for this reason, in a quarter of its files: the reader
   * saw asterisks where they had written bold, and editing the paragraph
   * escaped them into the file for good measure.
   *
   * This is the CommonMark community's own CJK-friendly amendment to the
   * flanking rules rather than a rule invented here.
   */
  cjkFriendlyExtension(),
  math({ singleDollarTextMath: true }),
  frontmatterSyntax,
];

/**
 * The same dialect for a document that cannot have frontmatter.
 *
 * `micromark-extension-frontmatter` tries its construct at the start of every
 * document. When a note opens with a `---` that nothing below closes, so a
 * thematic break rather than a fence, the failed attempt leaves the parser
 * unable to start a list after it: a rule, a blank line and `- a` came back as a
 * rule and a paragraph, and the editor drew the list as a line of text. Every
 * list in such a note was affected, however far down. Plain CommonMark reads it
 * correctly, and frontmatter can only open on the first line and close on a line
 * of its own, so the extension is left out when that fence is not there.
 */
const micromarkExtensionsWithoutFrontmatter = micromarkExtensions.filter((extension) => extension !== frontmatterSyntax);

const FRONTMATTER_OPEN = /^---[ \t]*(?:\r\n|\r|\n)/;
const FRONTMATTER_CLOSE = /^---[ \t]*(?:\r\n|\r|\n|$)/m;

/** Whether `text` opens with a `---` fence that a later `---` line closes. */
export function opensWithFrontmatterFence(text: string): boolean {
  const open = FRONTMATTER_OPEN.exec(text);
  return open !== null && FRONTMATTER_CLOSE.test(text.slice(open[0].length));
}

/**
 * The shape of a character reference: `&` and a name, or `#` and a decimal or
 * hexadecimal code point, then `;`. CommonMark reads it as the character it
 * stands for.
 *
 * Only the shape. Whether `&name;` really is one depends on the HTML entity
 * table, which only the parser consults; `&Year;` has the shape and is not one.
 * So a match means a reference may be there, never that one is.
 */
const AFTER_REFERENCE_AMPERSAND = '(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,30});';
const CHARACTER_REFERENCE_SHAPE = new RegExp(`&${AFTER_REFERENCE_AMPERSAND}`);
const WHOLE_CHARACTER_REFERENCE = new RegExp(`^&${AFTER_REFERENCE_AMPERSAND}$`);

/** An ampersand that cannot start a character reference. */
const LONE_AMPERSAND = new RegExp(`&(?!${AFTER_REFERENCE_AMPERSAND})`, 'g');

/** Whether `markdown` holds something shaped like a character reference. */
export function mayHoldCharacterReference(markdown: string): boolean {
  return markdown.includes('&') && CHARACTER_REFERENCE_SHAPE.test(markdown);
}

/** Whether `text` is exactly one thing shaped like a character reference. */
export function isCharacterReferenceShape(text: string): boolean {
  return WHOLE_CHARACTER_REFERENCE.test(text);
}

/**
 * Each character reference stays a node of its own instead of melting into
 * the text around it.
 *
 * mdast decodes `&amp;` into `&` and joins it to its neighbours, which is right
 * for reading and loses the spelling: an edited paragraph is written from the
 * tree, so `&amp;` would come back as `&`, `&nbsp;` as an invisible no-break
 * space and `&lt;b&gt;` as `\<b>`. Typora keeps what the author wrote, and so
 * does this, by carrying the written form next to the decoded character for the
 * serializer to put back (`characterReferenceVerbatim`).
 *
 * The decoding itself is mdast's: the reference's value is filled in by the
 * stock handler, on this node rather than on a text node. Strings that are not
 * phrasing, a link's destination or an image's alt, still read as the decoded
 * text, because they are built from the values of what is inside them, and
 * are written back as that text, which reads the same.
 */
const characterReferencesAsNodes: FromMarkdownExtension = {
  enter: {
    characterReference(this: CompileContext, token: Token) {
      const node: CharacterReference = { type: 'characterReference', value: '', source: '' };
      this.enter(node, token);
    },
  },
  exit: {
    characterReference(this: CompileContext, token: Token) {
      const node = this.stack[this.stack.length - 1] as unknown as CharacterReference;
      node.source = this.sliceSerialize(token);
      this.exit(token);
    },
  },
};

const mdastExtensions = [
  characterReferencesAsNodes,
  gfmFromMarkdown(),
  mathFromMarkdown(),
  frontmatterFromMarkdown(),
];

/**
 * Serializer settings chosen to match the conventions most markdown files in
 * the wild already use, so that re-serializing a block the user edited produces
 * the smallest possible diff against the rest of their document.
 */
/**
 * `[[wiki links]]` survive a re-serialize.
 *
 * The serializer escapes `[` in text, because a bare `[` can open a link
 * reference and it cannot know whether a matching definition exists elsewhere.
 * That is right in general and wrong here: it turns `[[note]]` into
 * `\[\[note]]`, so editing any paragraph containing a wiki link rewrites it,
 * and the link stops being one. The bug predates wiki links being rendered; it
 * was simply invisible while nothing looked for them.
 *
 * The exemption is narrow on purpose. Only a complete `[[...]]` with no
 * brackets, pipes or newlines inside is emitted verbatim; every other character
 * of the text still goes through the serializer's own escaping. A document
 * that also defines `[note]: …` would have its meaning changed by this, which
 * is the case the blanket escape defends. That collision needs a definition
 * whose label is exactly a wiki link's target, in a vault where `[[note]]` is
 * already being written as a link; between breaking that and breaking every
 * wiki link in the vault, this is the better trade, and it is recorded here so
 * the trade is visible rather than discovered.
 */
/**
 * One tilde is text.
 *
 * The parser reads `~2~` as the two characters and the digit, which is what
 * Typora does and what the vault writes for a subscript. The strikethrough
 * serializer, though, escapes every tilde in phrasing, so editing a paragraph
 * holding `H~2~O` saved it as `H\~2\~O`. Only a pair can strike now, so
 * only a tilde followed by another needs the escape.
 */
function tildeOnlyInPairs(extension: ToMarkdownOptions): ToMarkdownOptions {
  return {
    ...extension,
    unsafe: extension.unsafe?.map((rule) =>
      rule.character === '~' && rule.after === undefined ? { ...rule, after: '~' } : rule,
    ),
    extensions: extension.extensions?.map(tildeOnlyInPairs),
  };
}


/*
 * Runs the serializer must emit exactly as they are.
 *
 * `[[wiki links]]`, the `[!NOTE]` marker that opens a GitHub alert, a footnote
 * reference and the `[TOC]` marker. All of them begin with a `[`, which the
 * serializer escapes because a bare `[` can open a link reference and it cannot
 * know whether a matching definition exists. That is right in general and wrong
 * for these: escaping a wiki link stops it being one, escaping an alert's
 * marker stops the quote being an alert at all, and escaping a footnote
 * reference or a table of contents marker stops either from being what it says.
 * Each is recognised only in the shape that cannot mean anything else, and
 * everything around them still goes through the escaping.
 */
/**
 * A word character for CommonMark's flanking rules: letters, digits, and the
 * CJK ideographs these notes are mostly written in. Spelled out rather than as
 * a unicode property, because the pattern is built without the unicode flag.
 */
const WORD = `[0-9A-Za-z\u00C0-\u024F\u3400-\u4DBF\u4E00-\u9FFF]`;

/*
 * An identifier is the third: a run of word characters joined by underscores,
 * `mcp__claude_api` or `search_mcp_register`. CommonMark will not open or
 * close emphasis on an underscore with a word character on either side, which
 * is the rule that lets snake_case be written plainly, but the serializer
 * escapes every underscore in phrasing regardless. Editing any paragraph
 * naming an identifier turned it into `mcp\_\_claude\_api`. The run holds
 * nothing but word characters and underscores, so emitting it whole escapes
 * nothing that needed escaping.
 */
const VERBATIM_RUN = new RegExp(
  [
    '\\[\\[[^[\\]\\n|]+(?:\\|[^[\\]\\n]*)?\\]\\]',
    '\\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\]',
    // `==highlight==`, which the editor draws as a mark. A paragraph opening
    // with one had its first `=` escaped, because an `=` at the start of a
    // line can underline a setext heading, and `\\==text==` is no longer a
    // highlight. The run is only recognised whole, so it cannot mean that.
    '==[^=\\n]+==',
    /*
     * A footnote reference, `[^1]` or `[^longer-name]`.
     *
     * Blocks are parsed one at a time, and a footnote reference is only
     * recognised as one when its definition is in the same parse, so a
     * reference in a paragraph arrives here as ordinary text starting with a
     * `[`. Escaping it turned every footnote in an edited paragraph into the
     * literal characters `\[^1]`, which is not a footnote any more and not what
     * the file said. The label cannot hold whitespace or a bracket, so the run
     * is only recognised in the shape that can mean nothing else.
     */
    '\\[\\^[^\\]\\s]+\\]',
    // `[TOC]`, the marker Typora reads as a table of contents. It is a bare
    // link reference to a definition that does not exist, so the serializer
    // escapes it and the marker stops working.
    '\\[[Tt][Oo][Cc]\\]',
    `${WORD}+(?:_+${WORD}+)+`,
    /*
     * A metric or handle that is not an email: `NDCG@10`, `Recall@K`.
     *
     * GFM escapes `@` between word characters because `user@host` can open an
     * autolink. A real address is already a link node by the time it reaches
     * the text handler, so this run only ever sees the metric form, which the
     * parser leaves as ordinary text and which editing used to fill with
     * backslashes.
     */
    `${WORD}+@${WORD}+`,
    /*
     * A lone star glued to a word, `*nix` or `*BSD`. Real emphasis is already
     * an emphasis node, so the text handler never sees its delimiters. What it
     * does see is a star that CommonMark left literal, and the serializer then
     * escaped "just in case", rewriting every `*nix` in an edited heading.
     * Only where the star cannot pair with another: see `bareStarStaysLiteral`.
     * Keep this the only alternative that starts with a star.
     */
    `\\*[A-Za-z][A-Za-z0-9.+_-]*`,
  ].join('|'),
  'g',
);

/**
 * A URL written on its own stays written on its own.
 *
 * The serializer writes any link whose text is its own address as `<url>`,
 * which is correct markdown and not what these files say. The author's vault
 * holds 6,200 bare URLs against 145 in angle brackets, so re-serializing an
 * edited paragraph put brackets around six thousand addresses that never had
 * them, for a construct that appears in ordinary prose all the time.
 *
 * Only where it is unambiguous. The address has to be http or https, hold no
 * whitespace or angle brackets, and not end in punctuation, because GFM's own
 * autolink rule trims a trailing full stop or bracket off the end of a bare
 * URL and the address would come back shorter than it went in. Anything else
 * falls through to the serializer's own handler.
 */
const BARE_URL = /^https?:\/\/[^\s<>]*[^\s<>.,:;!?)\]]$/;

/**
 * A table's delimiter row, written the way the vault writes it.
 *
 * The serializer shortens each delimiter cell to a single dash, and pads every
 * cell out to its column's width when it is aligning. The vault does neither:
 * 4,039 of its delimiter rows are written with three dashes and two thirds of
 * its 43,076 table rows are unpadded. Alignment is turned off, which stops the
 * padding, and each delimiter cell is widened back to three dashes, which is
 * what a table looks like when a person writes one.
 *
 * The colons that carry a column's alignment are kept exactly where they were.
 */
export function widenDelimiterCells(line: string): string {
  return line.split('|').map((cell) => {
    const trimmed = cell.trim();
    if (!/^:?-+:?$/.test(trimmed)) return cell;
    const left = trimmed.startsWith(':') ? ':' : '';
    const right = trimmed.endsWith(':') ? ':' : '';
    const dashes = '-'.repeat(Math.max(3, trimmed.length - left.length - right.length));
    const lead = cell.startsWith(' ') ? ' ' : '';
    const tail = cell.endsWith(' ') ? ' ' : '';
    return `${lead}${left}${dashes}${right}${tail}`;
  }).join('|');
}

/** The table handler, with its delimiter row rewritten on the way out. */
function tablesAsTheVaultWritesThem(extension: ToMarkdownOptions): ToMarkdownOptions {
  const table = extension.handlers?.table;
  // The table handler lives in one of the GFM bundle's own sub-extensions
  // rather than at its top level, so the search goes down as well as across.
  const nested = extension.extensions?.map(tablesAsTheVaultWritesThem);
  if (typeof table !== 'function') {
    return nested ? { ...extension, extensions: nested } : extension;
  }
  return {
    ...extension,
    ...(nested ? { extensions: nested } : {}),
    handlers: {
      ...extension.handlers,
      table(node, parent, state, info) {
        const out = table.call(this, node, parent, state, info) as string;
        const lines = out.split('\n');
        if (lines.length < 2) return out;
        lines[1] = widenDelimiterCells(lines[1]);
        return lines.join('\n');
      },
    },
  };
}

const bareAutolink: ToMarkdownOptions = {
  handlers: {
    link(node, parent, state, info) {
      const [only] = node.children;
      if (
        node.children.length === 1
        && only?.type === 'text'
        && only.value === node.url
        && (node.title === null || node.title === undefined)
        && BARE_URL.test(node.url)
      ) {
        return node.url;
      }
      // The destination and the title; the link's text is the text handler's.
      return withSafe(state, withBareAmpersands, () => defaultHandlers.link(node, parent, state, info));
    },
  },
};

/**
 * A hard break written the way the author writes it: two trailing spaces.
 *
 * mdast writes a backslash, which is the unambiguous form and the reason it
 * was chosen. The vault disagrees by a wide margin, 16,328 lines ending in
 * two spaces against 237 ending in a backslash, so editing one paragraph of
 * an old note would rewrite every break in it into a form the file has never
 * used. Both mean the same thing to every parser here, so the file's own
 * convention wins.
 *
 * Only the backslash is rewritten. Everywhere the default handler degrades a
 * break to a space, inside a setext heading or a table cell where no newline
 * can go, it keeps doing so.
 */
const hardBreakAsTwoSpaces: ToMarkdownOptions = {
  handlers: {
    break(node, parent, state, info) {
      const written = defaultHandlers.break(node, parent, state, info);
      return written === '\\\n' ? '  \n' : written;
    },
  },
};

/**
 * Whether a `*nix` run can be written with its star bare.
 *
 * A star followed by a letter can always open emphasis. It is still literal if
 * nothing pairs with it, and outside a starred span nothing else can: every
 * other literal star is escaped, and a real span's closer pairs with its own
 * opener. So it is safe exactly when it cannot close. It can when a letter or
 * digit sits before it: `a\*b\*c` was saved as `a*b*c` and came back as
 * emphasis on `b`. Inside emphasis or strong, which this dialect writes with
 * stars, it pairs with the span's own delimiters: `*see a\*b*` was saved as
 * `*see a*b*` and came back as emphasis on `see a` and a literal `b*`.
 *
 * So the star stays bare only after whitespace, ASCII punctuation or the start
 * of the text, and only outside a starred span; everywhere else it takes the
 * serializer's escape like any other literal star. Other Unicode punctuation
 * is left out on purpose, because the CJK-friendly flanking rules let a star
 * after CJK punctuation close.
 */
function bareStarStaysLiteral(previous: string, stack: readonly string[]): boolean {
  if (stack.includes('emphasis') || stack.includes('strong')) return false;
  return previous === '' || /[\s!-\/:-@\[-`{-~]/.test(previous);
}

type Safe = (value: string, info: { before: string; after: string }) => string;

/**
 * `safe`, with every ampersand that cannot start a character reference
 * written bare.
 *
 * The serializer escapes any `&` before a letter or `#`, in case it begins a
 * reference, so editing a paragraph turned `Q&A` into `Q\&A` and the query of
 * a link, `?p=1&vd_source=…`, into `?p=1\&vd_source=…`; the vault holds the
 * second in 246 links across 100 notes. Only an `&` followed by the whole
 * shape of a reference can be read as one, so only that one keeps the escape,
 * and typing `&amp;` as text still saves as those five characters.
 *
 * Each stretch between bare ampersands is escaped with its real neighbours,
 * so the `&` is what the characters either side of it see.
 */
function withBareAmpersands(safe: Safe): Safe {
  return (value, info) => {
    if (!value.includes('&')) return safe(value, info);
    let out = '';
    let last = 0;
    for (const match of value.matchAll(LONE_AMPERSAND)) {
      if (match.index > last) {
        out += safe(value.slice(last, match.index), { ...info, before: last === 0 ? info.before : '&', after: '&' });
      }
      out += '&';
      last = match.index + 1;
    }
    if (last === 0) return safe(value, info);
    if (last < value.length) out += safe(value.slice(last), { ...info, before: '&' });
    return out;
  };
}

/**
 * Run a handler with `state.safe` replaced, putting the original back after.
 */
function withSafe<T>(state: { safe: Safe }, replacement: (original: Safe) => Safe, run: () => T): T {
  const original = state.safe;
  // The serializer's own `safe` reads its state from `this`.
  state.safe = replacement(original.bind(state));
  try {
    return run();
  } finally {
    state.safe = original;
  }
}

/**
 * Emit a string with the dialect's verbatim runs left alone.
 *
 * Shared by the text handler and the image handler: an image alt is not a
 * text node, so without this the same identifier that survives in a paragraph
 * is escaped inside `![img_v3_…](…)`.
 */
function emitWithVerbatimRuns(
  value: string,
  state: {
    safe: (value: string, info: { before: string; after: string }) => string;
    stack: readonly string[];
  },
  info: { before: string; after: string },
): string {
  VERBATIM_RUN.lastIndex = 0;
  if (!VERBATIM_RUN.test(value)) return state.safe(value, info);

  /*
   * Each ordinary segment is escaped with its real neighbours.
   *
   * `safe` decides from `before` and `after` whether a character sits at a
   * boundary that needs escaping, so a segment escaped as though it were
   * the whole string gets its leading and trailing spaces turned into
   * `&#x20;`. The neighbours here are known exactly: a segment before a
   * link is followed by `[`, one after a link is preceded by `]`.
   */
  VERBATIM_RUN.lastIndex = 0;
  let out = '';
  let last = 0;
  for (;;) {
    const match = VERBATIM_RUN.exec(value);
    if (match === null) break;
    if (match[0].startsWith('*')) {
      const previous = match.index > 0 ? value[match.index - 1]! : info.before.slice(-1);
      if (!bareStarStaysLiteral(previous, state.stack)) {
        // Leave the star to the ordinary segment, and let the rest of the run
        // still match on its own (`a*b_c` keeps `b_c` whole).
        VERBATIM_RUN.lastIndex = match.index + 1;
        continue;
      }
    }
    if (match.index > last) {
      out += state.safe(value.slice(last, match.index), {
        ...info,
        before: last === 0 ? info.before : ']',
        after: '[',
      });
    }
    out += match[0];
    last = match.index + match[0].length;
  }
  if (last < value.length) {
    out += state.safe(value.slice(last), { ...info, before: last === 0 ? info.before : ']' });
  }
  return out;
}

/**
 * A character reference is written the way the file wrote it.
 *
 * The node holds the spelling it was read with (`characterReferencesAsNodes`),
 * and that spelling is a complete reference, so nothing around it needs
 * escaping on its account. It reads as an `&` to the text before it.
 */
function characterReference(node: CharacterReference): string {
  return node.source;
}
characterReference.peek = (): string => '&';

const characterReferenceVerbatim: ToMarkdownOptions = {
  handlers: { characterReference },
};

const verbatimRunsInText: ToMarkdownOptions = {
  handlers: {
    text(node, _parent, state, info) {
      return emitWithVerbatimRuns(node.value, { safe: withBareAmpersands(state.safe.bind(state)), stack: state.stack }, info);
    },
    /*
     * An image alt is a plain string, not phrasing, so the text handler never
     * sees it. Typora-generated names are snake_case identifiers; escaping
     * every underscore rewrote the alt the first time anybody edited the
     * paragraph holding the image.
     */
    image(node, parent, state, info) {
      return withSafe(state, (original) => {
        const bare = withBareAmpersands(original);
        return (value, safeInfo) => {
          // Only the alt is passed with `after: ']'` immediately after `![`.
          if (safeInfo.after === ']' && safeInfo.before.endsWith('![')) {
            return emitWithVerbatimRuns(value, { safe: bare, stack: state.stack }, safeInfo);
          }
          // The destination and the title.
          return bare(value, safeInfo);
        };
      }, () => defaultHandlers.image(node, parent, state, info));
    },
  },
};

/**
 * A list keeps the marker its source used.
 *
 * The vault writes `-` most often, which is the serializer default, but a star
 * list still appears thousands of times. mdast does not record the marker, so
 * the editor carries it on the node and the handler swaps the option for the
 * duration of this list only.
 */
const listMarkerFromNode: ToMarkdownOptions = {
  handlers: {
    list(node, parent, state, info) {
      const data = node.data as { bullet?: string; delimiter?: string } | undefined;
      const previousBullet = state.options.bullet;
      const previousOrdered = state.options.bulletOrdered;
      if (!node.ordered && (data?.bullet === '*' || data?.bullet === '+' || data?.bullet === '-')) {
        state.options.bullet = data.bullet;
      }
      if (node.ordered && (data?.delimiter === '.' || data?.delimiter === ')')) {
        state.options.bulletOrdered = data.delimiter;
      }
      try {
        return defaultHandlers.list(node, parent, state, info);
      } finally {
        state.options.bullet = previousBullet;
        state.options.bulletOrdered = previousOrdered;
      }
    },
  },
};

/**
 * The characters each inline mark is written with.
 *
 * Exported because the editor reveals a mark's delimiters around the caret and
 * must show what a save would actually write. The two were once written out
 * separately and drifted: the serializer moved to a star for emphasis and the
 * reveal went on showing an underscore.
 *
 * The vault writes emphasis with a star, 5,280 times against 364 with an
 * underscore, so an edited paragraph keeps the form the file already uses.
 */
const EMPHASIS_MARKER = '*';
const STRONG_MARKER = '*';

export const INLINE_DELIMITERS = {
  emphasis: EMPHASIS_MARKER,
  strong: STRONG_MARKER.repeat(2),
  strikethrough: '~~',
  inline_code: '`',
} as const;

/**
 * Emphasis inside emphasis, written so it reads back as what it is.
 *
 * Every emphasis is written with a star, so `***nested _em_ strong***` with
 * the space before `em` deleted was saved as `***nested*em 1* strong***`. A
 * star between two letters can close as well as open, and that one closed the
 * outer run after `nested`: the paragraph came back as different emphasis
 * with a stray `**` at the end. Two runs of one marker nested in each other
 * only read back when the inner one sits where it cannot be taken for the
 * outer one's closer, and an edit decides where it sits.
 *
 * So a nested run takes the other marker. Inside a starred run it is written
 * with an underscore, which is how the file above already wrote it. Where an
 * underscore cannot open or close, against a letter, the inner run keeps its
 * star and the outer run takes the underscore instead, which gives
 * `**_nested*em 1* strong_**`. A run with no emphasis inside keeps the star.
 * Three runs nested in each other and glued to letters at every level have no
 * form in two markers at all; those are written as before.
 *
 * An underscore is only used with whitespace, ASCII punctuation or the edge of
 * the block on its outside. Other Unicode punctuation is left out on purpose,
 * as for `bareStarStaysLiteral`, because the CJK-friendly flanking rules treat
 * it differently for the two markers.
 */
const emphasisMarkers = new WeakMap<State, ('*' | '_')[]>();

/** Nodes written with punctuation on both edges: delimiters, brackets, a tag. */
const PUNCTUATION_EDGED = new Set([
  'emphasis', 'strong', 'delete', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference',
  'html', 'break', 'characterReference', 'inlineMath', 'footnoteReference',
]);

function underscoreSideFits(sibling: RootContent | undefined, edge: 'first' | 'last'): boolean {
  // No sibling: the parent's own delimiter or the edge of the block.
  if (!sibling) return true;
  if (sibling.type === 'text') {
    const character = edge === 'first' ? sibling.value.charAt(0) : sibling.value.charAt(sibling.value.length - 1);
    return character === '' || /[\s!-\/:-@\[-`{-~]/.test(character);
  }
  return PUNCTUATION_EDGED.has(sibling.type);
}

function underscoreFits(node: Emphasis, parent: Parents | undefined): boolean {
  if (!parent) return true;
  const siblings = parent.children as RootContent[];
  const index = siblings.indexOf(node);
  return underscoreSideFits(siblings[index - 1], 'last') && underscoreSideFits(siblings[index + 1], 'first');
}

/** The closest emphasis runs inside `node`, each with its parent. */
function innerEmphasis(node: Parents, found: { node: Emphasis; parent: Parents }[] = []): { node: Emphasis; parent: Parents }[] {
  for (const child of node.children as PhrasingContent[]) {
    if (child.type === 'emphasis') found.push({ node: child, parent: node });
    else if ('children' in child) innerEmphasis(child, found);
  }
  return found;
}

/**
 * The character a delimiter run at one edge of `node` has against it.
 *
 * Runs at the same edge are written next to each other, so this descends
 * through them to what is inside. Anything but text is written with
 * punctuation at its edges (a backtick, a bracket, a dollar), and stands in as
 * one.
 */
function edgeCharacter(node: RootContent, edge: 'first' | 'last'): string {
  let current: RootContent | undefined = node;
  while (current && (current.type === 'emphasis' || current.type === 'strong')) {
    const children: PhrasingContent[] = current.children;
    current = edge === 'first' ? children[0] : children[children.length - 1];
  }
  if (!current) return '';
  if (current.type !== 'text') return '!';
  return edge === 'first' ? current.value.charAt(0) : current.value.charAt(current.value.length - 1);
}

/**
 * Whether the stars where one run closes and the next opens read back as that.
 *
 * Both are written with stars, so they fuse into one delimiter run such as the
 * `***` in `*a***b**`. That run has to close the first and open the second,
 * which CommonMark only allows when it is both left- and right-flanking: no
 * whitespace on either side, and punctuation on both sides or on neither.
 */
function touchingStarsReadBack(before: string, after: string): boolean {
  if (before === '' || after === '' || /\s/u.test(before) || /\s/u.test(after)) return false;
  const punctuation = /[\p{P}\p{S}]/u;
  return punctuation.test(before) === punctuation.test(after);
}

/**
 * An emphasis run touching a strong run whose stars would not read back.
 *
 * `*a.b*` then `**<x**` was saved as `*a.b***<x**`. The `***` sits between a
 * letter and punctuation, so it can only close: the strong text came back as
 * literal stars. Written with an underscore, `_a.b_**<x**`, each run has its
 * own delimiters again. Two strong runs or two emphasis runs never touch (the
 * editor merges them), so emphasis next to strong is the only pair.
 */
function touchesStrongStars(node: Emphasis, parent: Parents | undefined): boolean {
  if (!parent) return false;
  const siblings = parent.children as RootContent[];
  const index = siblings.indexOf(node);
  const before = siblings[index - 1];
  const after = siblings[index + 1];
  return (before?.type === 'strong' && !touchingStarsReadBack(edgeCharacter(before, 'last'), edgeCharacter(node, 'first')))
    || (after?.type === 'strong' && !touchingStarsReadBack(edgeCharacter(node, 'last'), edgeCharacter(after, 'first')));
}

function emphasisMarker(node: Emphasis, parent: Parents | undefined, state: State): '*' | '_' {
  const enclosing = emphasisMarkers.get(state)?.at(-1);
  if (enclosing === '_') return '*';
  const wantsUnderscore = enclosing === '*'
    || touchesStrongStars(node, parent)
    || innerEmphasis(node).some((inner) => !underscoreFits(inner.node, inner.parent));
  return wantsUnderscore && underscoreFits(node, parent) ? '_' : '*';
}

/** The CJK-friendly emphasis handler, writing each run with its own marker. */
function nestedEmphasisAlternates(extension: ToMarkdownOptions): ToMarkdownOptions {
  const write = extension.handlers?.emphasis;
  if (typeof write !== 'function') throw new Error('expected an emphasis handler to wrap');
  const handle: Handle = (node: Emphasis, parent, state, info) => {
    const marker = emphasisMarker(node, parent, state);
    const stack = emphasisMarkers.get(state) ?? [];
    emphasisMarkers.set(state, stack);
    const previous = state.options.emphasis;
    state.options.emphasis = marker;
    stack.push(marker);
    try {
      return write(node, parent, state, info);
    } finally {
      stack.pop();
      state.options.emphasis = previous;
    }
  };
  // Peeked by the sibling before this run, with the same enclosing runs open.
  const peek = (node: Emphasis, parent: Parents | undefined, state: State): string => emphasisMarker(node, parent, state);
  const emphasis = Object.assign(handle, { peek });
  return { ...extension, handlers: { ...extension.handlers, emphasis } };
}

const serializerOptions: ToMarkdownOptions = {
  bullet: '-',
  emphasis: EMPHASIS_MARKER,
  strong: STRONG_MARKER,
  fence: '`',
  fences: true,
  listItemIndent: 'one',
  rule: '-',
  ruleSpaces: false,
  tightDefinitions: true,
  extensions: [
    // The writing half of the CJK amendment. Without it the serializer keeps
    // CommonMark's own flanking rules and, believing the run cannot close,
    // escapes the Chinese character after it into a numeric reference.
    nestedEmphasisAlternates(cjkFriendlyToMarkdown()),
    tablesAsTheVaultWritesThem(tildeOnlyInPairs(gfmToMarkdown({ tablePipeAlign: false }))), mathToMarkdown(), frontmatterToMarkdown(), characterReferenceVerbatim, verbatimRunsInText, listMarkerFromNode, bareAutolink, hardBreakAsTwoSpaces],
};

/**
 * Parse markdown into an mdast tree with source positions.
 *
 * `text` must already have any BOM removed, because micromark treats a leading
 * U+FEFF as content and it would shift every offset by one.
 */
export function parseMarkdown(text: string): Root {
  const extensions = opensWithFrontmatterFence(text) ? micromarkExtensions : micromarkExtensionsWithoutFrontmatter;
  return fromMarkdown(text, { extensions, mdastExtensions });
}

/**
 * Render a single mdast node back to markdown.
 *
 * Only used for blocks the user actually edited. Untouched blocks are sliced
 * from the original source instead, which is what keeps saves byte exact.
 */
export function renderMarkdown(node: Nodes): string {
  return toMarkdown(node, serializerOptions);
}

/**
 * Top level children of a parsed document, which is the granularity at which
 * Noto tracks source provenance.
 */
export function topLevelNodes(root: Root): readonly RootContent[] {
  return root.children;
}
