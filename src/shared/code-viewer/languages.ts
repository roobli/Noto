/**
 * Filename → highlighter language for the read-only code viewer.
 *
 * Ported from the author's typora-plugin-lite `code-viewer`: a known text/code
 * extension opens read-only; markdown stays a real document; an unknown but
 * textual extension opens as plain text rather than being refused.
 * `.drawio` opens as XML (source-only); `.html`/`.htm`/`.xhtml`/`.svg` and
 * `.drawio.svg` are `markup` and the viewer can offer an isolated Preview.
 */

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt']);

/** Extensions matched by full basename rather than a dotted suffix. */
const FILENAME_LANG: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  cmakelists: 'cmake',
  '.gitignore': 'gitignore',
  '.gitattributes': 'ini',
  '.env': 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.vimrc': 'vim',
};

const EXT_LANG: Readonly<Record<string, string>> = {
  py: 'python', pyw: 'python', pyi: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  rb: 'ruby', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua',
  r: 'r', jl: 'julia', dart: 'dart', groovy: 'groovy',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ksh: 'bash',
  ps1: 'powershell', psm1: 'powershell', bat: 'text', cmd: 'text',
  c: 'c', h: 'c',
  cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', swift: 'swift', zig: 'zig', nim: 'nim',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  clj: 'clojure', cljs: 'clojure',
  hs: 'haskell', ml: 'ocaml', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  html: 'markup', htm: 'markup', xhtml: 'markup', vue: 'markup',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  json: 'json', json5: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'markup', svg: 'markup', plist: 'markup',
  drawio: 'xml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  tf: 'hcl', hcl: 'hcl', nix: 'nix', cmake: 'cmake',
  dockerignore: 'gitignore',
  tex: 'latex', rst: 'text', org: 'text',
  csv: 'text', tsv: 'text', log: 'text',
  diff: 'diff', patch: 'diff',
  vim: 'vim', el: 'text', lisp: 'text', scm: 'text',
};

/** Extensions that cannot usefully be shown as text. */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'tar',
  'dmg', 'pkg', 'app', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat',
  'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'wav', 'flac', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'sqlite3', 'db', 'jar', 'class', 'pyc', 'o', 'a',
]);

function splitExt(fileName: string): { base: string; ext: string } {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, ext: '' };
  return { base: name, ext: name.slice(dot + 1) };
}


/**
 * True for files that describe a page (HTML / XHTML / SVG), so the code
 * viewer can offer an isolated Preview as well as Source.
 *
 * Matches the author's typora-plugin-lite `isRenderableMarkup`. Plain
 * `.drawio` XML is excluded; `.drawio.svg` matches via the `.svg` suffix.
 */
export function isRenderableMarkupFileName(fileName: string): boolean {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  return /\.(html?|xhtml|svg)$/i.test(name);
}

/** True for `.html` / `.htm` / `.xhtml` (sandboxed iframe preview). */
export function isHtmlMarkupFileName(fileName: string): boolean {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  return /\.(html?|xhtml)$/i.test(name);
}

/**
 * True for any `.svg` including `.drawio.svg` (blob `<img>` preview).
 * Distinguishing the draw.io export uses `isDrawioSvgFileName`.
 */
export function isSvgMarkupFileName(fileName: string): boolean {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  return /\.svg$/i.test(name);
}

/** True for diagrams.net / draw.io native XML (`.drawio`). */
export function isDrawioFileName(fileName: string): boolean {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  return /\.drawio$/i.test(name);
}

/**
 * True for a draw.io SVG export (`.drawio.svg`).
 *
 * `splitExt` only sees the final `.svg`, so callers that need the compound
 * name must use this rather than `languageFor`.
 */
export function isDrawioSvgFileName(fileName: string): boolean {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  return /\.drawio\.svg$/i.test(name);
}

/** True for Noto's own document types, which must never be code-viewed. */
export function isMarkdownFileName(fileName: string): boolean {
  const { ext } = splitExt(fileName);
  return MARKDOWN_EXTS.has(ext.toLowerCase());
}

/**
 * The highlighter language for this filename, or null if it should not be
 * code-viewed (markdown, or a known binary). An unknown textual extension
 * returns '' — open it as plain monospace rather than refusing.
 */
export function languageFor(fileName: string): string | null {
  const { base, ext } = splitExt(fileName);
  if (!base) return null;
  if (isMarkdownFileName(fileName)) return null;

  const lowerBase = base.toLowerCase();
  if (lowerBase in FILENAME_LANG) return FILENAME_LANG[lowerBase]!;

  const lowerExt = ext.toLowerCase();
  if (!lowerExt) return '';
  if (BINARY_EXTS.has(lowerExt)) return null;
  return EXT_LANG[lowerExt] ?? '';
}

/** Whether the tree / open path should offer this file to the code viewer. */
export function isViewableCodeFile(fileName: string): boolean {
  return languageFor(fileName) !== null;
}
