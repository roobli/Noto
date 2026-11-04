/**
 * A guess at the language of a code fence that does not name one.
 *
 * Most fences pasted from a chat, a terminal or a web page come without a
 * language, and without one they were drawn as plain text. This reads the
 * code for the marks a language leaves (a `def` that ends in a colon, a
 * `package` line, `:=`, a command at the start of a line) and names the
 * language only when one stands clearly above the rest. A fence it cannot
 * place stays plain, which is better than colours that are wrong.
 *
 * It is a scorer, not a parser: each rule adds weight to a language for each
 * line it matches, up to a cap, so one stray match never decides. The guess
 * only colours the fence and is offered in its language label; the file is
 * not changed until the reader keeps it.
 */

type Rule = readonly [language: string, pattern: RegExp, weight: number, cap?: number];

/** Enough of the code to know it by, and little enough to read on every keystroke. */
const SAMPLE = 2000;
/** The least a language must score to be named. */
const ENOUGH = 4;
/** How far it must stand above the next. */
const MARGIN = 2;

const COMMANDS = 'cd|ls|ll|git|npm|pnpm|yarn|npx|bun|brew|apt|apt-get|yum|dnf|pacman|docker|docker-compose|kubectl|helm|curl|wget|pip|pip3|pipx|uv|conda|export|echo|mkdir|rm|cp|mv|chmod|chown|cat|grep|rg|find|ssh|scp|rsync|make|cargo|rustup|systemctl|journalctl|tar|unzip|sed|awk|source|alias|terraform|gh|nvm|deno|touch|ln|kill|pkill|df|du|tail|head|xargs|jq|openssl|gcloud|aws|ffmpeg|launchctl|defaults|sudo|go (?:build|run|test|mod|get|install)|python3? -m';

const RULES: readonly Rule[] = [
  // Shell
  ['bash', /^#!.*\b(?:ba|z)?sh\b/m, 10],
  ['bash', new RegExp(`^\\s*(?:\\$\\s+)?(?:${COMMANDS})(?=\\s|$)`, 'gm'), 4, 6],
  ['bash', /^\s*\$\s+\S/gm, 3, 4],
  ['bash', /^\s*(?:if \[|elif \[|fi|then|esac|done|do)\b/gm, 3, 3],
  ['bash', /\|\s*(?:grep|awk|sed|xargs|head|tail|sort|uniq|wc|jq|tee)\b/g, 2, 3],
  ['bash', /\s--?[a-zA-Z][\w-]*/g, 0.5, 4],
  ['bash', /\$\{?[A-Za-z_]\w*\}?/g, 0.5, 4],

  // Python
  ['python', /^#!.*python/m, 10],
  ['python', /^\s*(?:async\s+)?def\s+\w+\s*\(.*\)\s*(?:->\s*[^:]+)?:\s*$/gm, 6, 3],
  ['python', /^\s*class\s+\w+(?:\([^)]*\))?:\s*$/gm, 6, 2],
  ['python', /^\s*(?:from\s+[\w.]+\s+)?import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*\s*$/gm, 3, 3],
  ['python', /^\s*(?:elif\b.*|except\b.*|try|finally|with\b.+\bas\s+\w+|for\s+\w+(?:\s*,\s*\w+)*\s+in\s+.+)\s*:\s*$/gm, 4, 3],
  ['python', /\bself\.\w+/g, 2, 3],
  ['python', /\b(?:None|True|False)\b/g, 1, 3],
  ['python', /^if __name__ == ['"]__main__['"]:/m, 10],
  ['python', /\bf["'][^"']*\{/g, 1, 2],
  ['python', /\bprint\(/g, 1, 2],

  // JavaScript, and TypeScript on top of it (see `typescript` below)
  ['javascript', /\b(?:const|var)\s+[\w$]+\s*=/g, 2, 4],
  ['javascript', /\blet\s+[\w$]+\s*=/g, 1, 3],
  ['javascript', /=>/g, 1, 4],
  ['javascript', /\bfunction\b\s*[\w$]*\s*\(/g, 2, 3],
  ['javascript', /\bconsole\.(?:log|error|warn|info)\(/g, 5, 2],
  ['javascript', /\brequire\(['"]/g, 3, 2],
  ['javascript', /^\s*import\s+.+\s+from\s+['"]/gm, 4, 3],
  ['javascript', /^\s*import\s+['"]/gm, 3, 2],
  ['javascript', /^\s*export\s+(?:default|const|function|class|async|let)\b/gm, 4, 2],
  ['javascript', /\b(?:document|window)\.\w+/g, 3, 2],
  ['javascript', /===|!==/g, 2, 2],
  ['typescript', /\b\w+\??\s*:\s*(?:string|number|boolean|any|unknown|void|never)\b/g, 3, 3],
  ['typescript', /^\s*(?:export\s+)?interface\s+\w+/gm, 5, 2],
  ['typescript', /^\s*(?:export\s+)?type\s+\w+\s*(?:<[^>]*>)?\s*=/gm, 5, 2],
  ['typescript', /\bas\s+(?:const|string|number|any|unknown)\b/g, 3, 2],

  // JSON that does not parse, cut short or with comments
  ['json', /^\s*"[^"\n]+"\s*:/gm, 2, 4],

  // YAML
  ['yaml', /^\s*(?:-\s+)?[\w.-]+:\s+\S/gm, 1.5, 6],
  ['yaml', /^\s*(?!(?:else|try|finally|except|elif|if|for|while|with|def|class|default|case|public|private|protected)\b)[\w.-]+:\s*$/gm, 1, 4],
  ['yaml', /^---\s*$/gm, 2, 1],
  ['yaml', /^\s*(?:apiVersion|kind|metadata|spec|services|image|steps|jobs|runs-on|uses):/gm, 3, 3],
  ['yaml', /[;{}]\s*$/gm, -1, 6],
  // A line with no key, no item and no comment is not YAML: `commit 8474d13`.
  ['yaml', /^\s*(?![-#\s])[^:\n]+$/gm, -2, 4],

  // TOML and INI
  ['toml', /^\s*\[\[?[\w.\- "]+\]\]?\s*$/gm, 2, 3],
  ['toml', /^\s*[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*'|\d|true\b|false\b|\[|\{)/gm, 2, 5],
  ['ini', /^\s*\[[\w.\- ]+\]\s*$/gm, 2, 3],
  ['ini', /^\s*[\w.-]+\s*=\s*[^"'\s[{\d]/gm, 1.5, 5],

  // Go
  ['go', /^package\s+\w+\s*$/m, 8],
  ['go', /^\s*func\s+(?:\([^)]*\)\s*)?\w+\s*\(/gm, 4, 3],
  ['go', /:=/g, 2, 3],
  ['go', /\bfmt\.\w+\(/g, 5, 2],
  ['go', /^import\s*(?:\(|"[^"]+")/m, 4],
  ['go', /\berr\s*!=\s*nil\b/g, 6, 2],

  // Rust
  ['rust', /\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/g, 5, 3],
  ['rust', /\blet\s+mut\s+/g, 6, 2],
  ['rust', /^\s*(?:impl\b|(?:pub\s+)?trait\s+\w+)/gm, 5, 2],
  ['rust', /^\s*pub(?:\(crate\))?\s+(?:fn|struct|enum|mod|use)\b/gm, 4, 2],
  ['rust', /\b(?:println|vec|format|macro_rules|panic|assert_eq|eprintln)!/g, 6, 2],
  ['rust', /^\s*use\s+\w+(?:::[\w{}*, ]+)+;/gm, 5, 2],
  ['rust', /&(?:mut\s+)?(?:str|self)\b|\bOption<|\bResult<|\bSome\(|\bOk\(/g, 3, 3],

  // Java and C#
  ['java', /\bSystem\.out\.print(?:ln)?\(/g, 8, 1],
  ['java', /^\s*import\s+javax?\./gm, 8, 1],
  ['java', /^\s*package\s+[\w.]+;/m, 6],
  ['java', /@Override\b/g, 5, 1],
  ['java', /\bString\[\]\s+args\b/g, 6, 1],
  ['java', /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|void|record)\b/gm, 3, 2],
  ['csharp', /^\s*using\s+System(?:\.\w+)*;/gm, 8, 1],
  ['csharp', /\bConsole\.Write(?:Line)?\(/g, 8, 1],
  ['csharp', /\{\s*get;\s*(?:(?:private\s+)?set;)?\s*\}/g, 6, 1],
  ['csharp', /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:class|interface|void)\b/gm, 2, 2],

  // C, and C++ on top of it (see `cpp` below)
  ['c', /^\s*#include\s*[<"]/gm, 6, 1],
  ['c', /^\s*#(?:define|ifndef|ifdef|endif|pragma)\b/gm, 3, 2],
  ['c', /\bint\s+main\s*\(/g, 4, 1],
  ['c', /\bprintf\s*\(|\bmalloc\s*\(|#include\s*<(?:stdio|stdlib|string|unistd)\.h>/g, 2, 3],
  ['cpp', /\bstd::\w+|\b(?:cout|cin|cerr)\s*(?:<<|>>)|\btemplate\s*<|\bnullptr\b|#include\s*<(?:iostream|vector|string|map|memory|algorithm)>/g, 4, 3],

  // PHP and Ruby
  ['php', /<\?php/g, 15, 1],
  ['php', /\$this->|\$\w+\s*->\s*\w+/g, 3, 3],
  ['ruby', /^\s*def\s+\w+[?!]?(?:\(.*\))?\s*$/gm, 3, 3],
  ['ruby', /^\s*end\s*$/gm, 1.5, 4],
  ['ruby', /\bputs\s|\.each\s+do\s*\||\bdo\s*\|[\w, ]+\||\battr_(?:accessor|reader|writer)\b/g, 5, 2],
  ['ruby', /^\s*class\s+\w+\s*<\s*\w+/gm, 5, 1],

  // Lua
  ['lua', /^\s*local\s+(?:function\s+)?\w+/gm, 4, 3],
  ['lua', /~=|\belseif\b/g, 3, 2],
  ['lua', /^\s*end\s*$/gm, 1, 3],

  // SQL
  ['sql', /\bselect\b[\s\S]{1,400}?\bfrom\b/i, 6],
  ['sql', /^\s*(?:insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(?:table|index|view|database|schema)|alter\s+table|drop\s+(?:table|index|database)|truncate\s+table|with\s+\w+\s+as\s*\()/gim, 7, 2],
  ['sql', /\b(?:where|join|group\s+by|order\s+by|limit|values|primary\s+key|varchar)\b/gi, 1, 4],

  // HTML and XML
  ['html', /<!doctype\s+html/i, 10],
  ['html', /<(?:html|head|body|div|span|p|a|ul|ol|li|script|style|table|tr|td|img|meta|link|section|header|footer|button|input|form|template|h[1-6])\b[^>]*>/g, 2, 6],
  ['html', /<\/[a-z][\w-]*>/g, 1, 4],
  ['xml', /^\s*<\?xml\b/m, 12],
  ['xml', /<\/?[\w-]+:[\w-]+[\s/>]/g, 2, 3],

  // CSS, and SCSS on top of it (see `scss` below)
  ['css', /^\s*(?:[.#]?[\w-]+|\*|::?[\w-]+)(?:[\s,>+~]+(?:[.#]?[\w-]+|::?[\w-]+))*\s*\{\s*$/gm, 1, 4],
  ['css', /^\s*[a-z-]+\s*:\s*[^;{}\n]+;\s*$/gm, 1.5, 6],
  ['css', /@(?:media|import|keyframes|font-face|supports)\b/g, 5, 1],
  ['css', /\b\d+(?:px|rem|em|vh|vw)\b/g, 1, 3],
  ['scss', /^\s*\$[\w-]+\s*:|@(?:mixin|include|extend|use|forward)\b|&(?::|\.|-)/gm, 4, 2],

  // Build and config files
  ['dockerfile', /^FROM\s+[\w.-]+(?:[:/@][\w./:@-]+)+/m, 6],
  ['dockerfile', /^(?:RUN|CMD|COPY|ADD|ENV|WORKDIR|EXPOSE|ENTRYPOINT|ARG|USER|VOLUME|LABEL)\s/gm, 4, 5],
  ['nginx', /^\s*(?:server|location|upstream|http|events)\b[^{;\n]*\{/gm, 3, 3],
  ['nginx', /^\s*(?:listen|server_name|proxy_pass|root|index|rewrite|add_header|proxy_set_header|ssl_certificate)\s+[^;\n]+;/gm, 3, 4],
  ['makefile', /^\.PHONY\s*:/m, 10],
  ['makefile', /^[\w.%/-]+(?:\s+[\w.%/-]+)*\s*:(?!=)[^\n]*\n\t/gm, 5, 3],
  ['makefile', /\$\((?:CC|CFLAGS|MAKE|shell|wildcard|patsubst)\b/g, 4, 2],
  ['powershell', /\b(?:Get|Set|New|Remove|Write|Invoke|Start|Stop|Import|Export)-[A-Z]\w+/g, 6, 2],
  ['powershell', /\s-(?:ErrorAction|Path|Force|Recurse)\b/g, 2, 2],
  ['http', /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d(?:\.\d)?\s*$|^HTTP\/\d(?:\.\d)?\s+\d{3}\b/m, 12],
  ['diff', /^diff --git\s|^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m, 10],
  ['diff', /^(?:---|\+\+\+)\s+(?:a\/|b\/|\S+\s+\d{4}-)/gm, 4, 2],
  ['diff', /^[+-](?![+-])/gm, 0.5, 6],
  ['vim', /^\s*(?:set\s+\w+|let\s+[gbsl]:|n?noremap|inoremap|vnoremap|nmap|autocmd|augroup|syntax\s+on|filetype\s+plugin|colorscheme)\b/gm, 4, 4],

  // Other languages, by their surest marks
  ['swift', /^\s*import\s+(?:UIKit|SwiftUI|Foundation|Combine|AppKit)\s*$/m, 10],
  ['swift', /\bguard\s+let\b|\bif\s+let\b|@(?:State|Published|Binding|main|objc|IBOutlet)\b|\bstruct\s+\w+\s*:\s*View\b/g, 6, 2],
  ['kotlin', /\bfun\s+(?:<[^>]*>\s*)?[\w.]+\s*\(/g, 6, 2],
  ['kotlin', /\bdata\s+class\b|\bcompanion\s+object\b/g, 6, 1],
  ['kotlin', /\bval\s+\w+\s*(?::\s*\w+)?\s*=/g, 2, 3],
  ['scala', /\bcase\s+class\b|\bobject\s+\w+\s+extends\b|\bdef\s+\w+\s*(?:\[[^\]]*\])?\s*\(.*\)\s*:\s*\w+\s*=/g, 6, 2],
  ['haskell', /^\w+\s*::\s*/gm, 6, 3],
  ['haskell', /^import\s+qualified\b|^module\s+[A-Z][\w.]*\s+where/m, 8],
  ['elixir', /^\s*defmodule\s+[A-Z]|\bIO\.puts\b/m, 8],
  ['elixir', /^\s*defp?\s+\w+.*\bdo\s*$/gm, 5, 2],
  ['elixir', /\|>/g, 2, 3],
  ['erlang', /^-module\(/m, 10],
  ['r', /\blibrary\(\w+\)|\bggplot\(|\bdata\.frame\(/g, 6, 2],
  ['r', /\w+\s*<-\s*/g, 2, 4],
  ['perl', /^\s*use\s+strict;|^#!.*perl|\bmy\s+[$@%]\w+/gm, 5, 2],
  ['latex', /\\(?:documentclass|usepackage|begin|end)\{/g, 5, 3],
  ['latex', /\\(?:section|subsection|textbf|emph|frac|label|ref|cite)\{/g, 2, 3],
  ['graphql', /^\s*(?:query|mutation|subscription|fragment)\s+\w+[\s({]/gm, 6, 2],
  ['graphql', /^\s*\w+\s*(?:\([^)]*\))?\s*:\s*\[?[A-Z]\w*!/gm, 3, 3],
  ['protobuf', /^\s*syntax\s*=\s*"proto[23]"/m, 12],
  ['protobuf', /^\s*(?:repeated|optional|required)?\s*\w+\s+\w+\s*=\s*\d+;/gm, 3, 3],
  ['dart', /^\s*import\s+'package:|\bWidget\s+build\(|@override\b/gm, 8, 2],
  ['groovy', /\b(?:implementation|testImplementation|compileOnly)\s*[('"]|^\s*(?:plugins|dependencies|repositories|android)\s*\{/gm, 5, 2],
  ['zig', /@import\("std"\)/g, 12, 1],
  ['objectivec', /^\s*#import\s*[<"]|@(?:interface|implementation|property)\b/gm, 6, 2],
  ['lisp', /^\s*\((?:defun|defvar|defmacro|setq|use-package|defcustom)\b/gm, 5, 3],
  ['markdown', /^\s*[-*+]\s+\[[ xX]\]\s|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|^`{3}/gm, 2, 4],
  ['markdown', /^#{1,6}\s+\S/gm, 1, 3],
  ['mermaid', /^\s*(?:(?:graph|flowchart)\s+(?:TD|TB|BT|RL|LR)\b|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|journey|gitGraph|mindmap)/m, 12],
];

/** A language that is another one with more on top: named only when its own marks are there. */
const ON_TOP: ReadonlyArray<readonly [extra: string, base: string, needs: number]> = [
  ['typescript', 'javascript', 3],
  ['cpp', 'c', 4],
  ['scss', 'css', 4],
];

function count(text: string, pattern: RegExp): number {
  if (!pattern.global) return pattern.test(text) ? 1 : 0;
  pattern.lastIndex = 0;
  let found = 0;
  for (let hit = pattern.exec(text); hit !== null; hit = pattern.exec(text)) {
    found += 1;
    // A match of nothing would leave the search where it was.
    if (hit[0].length === 0) pattern.lastIndex += 1;
  }
  return found;
}

/** The language a fence's code reads as, or null when none stands out. */
export function detectLanguage(code: string): string | null {
  const text = code.length > SAMPLE ? code.slice(0, SAMPLE) : code;
  const trimmed = text.trim();
  if (trimmed.replace(/\s/g, '').length < 3) return null;

  // Whole JSON is JSON, and the parser is the surest test there is.
  if (code.length <= SAMPLE && /^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not whole JSON: the rules decide.
    }
  }

  const scores = new Map<string, number>();
  for (const [language, pattern, weight, cap = 1] of RULES) {
    const hits = Math.min(count(text, pattern), cap);
    if (hits > 0) scores.set(language, (scores.get(language) ?? 0) + hits * weight);
  }
  // A key in quotes is JSON's only when the whole thing is an object or a list:
  // `config = {"host": ...}` is a dict in a program.
  if (!/^[[{]/.test(trimmed)) scores.delete('json');
  for (const [extra, base, needs] of ON_TOP) {
    const own = scores.get(extra) ?? 0;
    const under = scores.get(base) ?? 0;
    if (own >= needs) {
      scores.set(extra, own + under);
      scores.delete(base);
    } else {
      scores.delete(extra);
    }
  }

  let best: string | null = null;
  let top = 0;
  let next = 0;
  for (const [language, score] of scores) {
    if (score > top) {
      next = top;
      top = score;
      best = language;
    } else if (score > next) {
      next = score;
    }
  }
  if (best === null || top < ENOUGH || top - next < MARGIN) return null;
  // Script with markup in it is JSX, or TSX.
  if ((best === 'javascript' || best === 'typescript') && (scores.get('html') ?? 0) >= 2) {
    return best === 'javascript' ? 'jsx' : 'tsx';
  }
  return best;
}
