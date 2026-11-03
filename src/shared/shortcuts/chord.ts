/**
 * One spelling for a key chord, whoever declared it.
 *
 * The menu writes Electron accelerators (`Shift+CmdOrCtrl+T`), the editor
 * writes ProseMirror key names (`Meta-Shift-t`), and plugins write their own
 * (`Mod+Shift+ArrowUp`). The same press spelled three ways cannot be compared,
 * which is how two menu items came to share Shift-Command-T without the
 * duplicate check noticing. Every chord is turned into one canonical form
 * here: `Mod`, `Ctrl`, `Alt`, `Shift` in that order, then the key, joined by
 * `+`. `Mod` is Command on macOS and Control elsewhere, so a chord written once
 * names the same keys on every platform, and `Ctrl` survives only on macOS,
 * where it is a key of its own.
 *
 * A disabled shortcut is stored in this form, so turning one off turns off the
 * press wherever it is bound: the menu, the editor and a plugin alike.
 */

export type ChordSyntax = 'accelerator' | 'prosemirror';

const NAMED_KEYS: Readonly<Record<string, string>> = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  plus: 'Plus', '+': 'Plus', space: 'Space', ' ': 'Space',
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', tab: 'Tab',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};

const PUNCTUATION = new Set(['`', '-', '=', '[', ']', ';', "'", ',', '.', '/', '\\']);

const CANONICAL_KEY = /^(?:[A-Z0-9]|[`\-=[\];',./\\]|Plus|Space|Enter|Tab|Backspace|Delete|Escape|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-9]|2[0-4]))$/;
const CANONICAL = /^(?:Mod\+)?(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?([^+]+)$/;

function canonicalKey(raw: string): string | null {
  if (raw.length === 1) {
    if (/[a-z0-9]/i.test(raw)) return raw.toUpperCase();
    if (PUNCTUATION.has(raw)) return raw;
  }
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  return null;
}

/**
 * The canonical form of a chord, or null for one this cannot read (a chord
 * with no key, an unknown key, or the Windows key off macOS).
 */
export function normalizeChord(raw: string, syntax: ChordSyntax, mac: boolean): string | null {
  let parts: string[];
  if (syntax === 'prosemirror') {
    // ProseMirror spells the minus key as a trailing `-` after the separator.
    parts = raw.endsWith('--') ? [...raw.slice(0, -2).split('-'), '-'] : raw.split('-');
  } else {
    parts = raw.split('+');
  }
  const key = canonicalKey(parts.pop() ?? '');
  if (!key) return null;
  const held = new Set<string>();
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod': case 'cmdorctrl': case 'commandorcontrol':
        held.add('Mod'); break;
      case 'cmd': case 'command': case 'meta': case 'super':
        if (!mac) return null;
        held.add('Mod'); break;
      case 'ctrl': case 'control':
        held.add(mac ? 'Ctrl' : 'Mod'); break;
      case 'alt': case 'option': case 'altgr':
        held.add('Alt'); break;
      case 'shift':
        held.add('Shift'); break;
      default:
        return null;
    }
  }
  return [...['Mod', 'Ctrl', 'Alt', 'Shift'].filter((name) => held.has(name)), key].join('+');
}

/** Whether a string is a chord in canonical form, as settings store them. */
export function isCanonicalChord(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return false;
  const match = CANONICAL.exec(value);
  return match !== null && CANONICAL_KEY.test(match[1] ?? '');
}

/**
 * The canonical chord a key press makes.
 *
 * Read from the character typed where that is a plain letter, digit or
 * punctuation mark, as the menu and the editor read it, so on a Dvorak or
 * Colemak keyboard the same press means the same chord to all three. Read
 * from the physical key only when the character says nothing: Option on
 * macOS turns T into a dagger, Shift turns 1 into !, and a Cyrillic layout
 * types letters the chord tables do not hold.
 */
export function chordOfEvent(
  event: { readonly key?: string; readonly code: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean },
  mac: boolean,
): string | null {
  const code = event.code;
  const typed = event.key ?? '';
  let key: string | null = null;
  if (typed.length === 1 && /[a-z0-9]/i.test(typed)) key = typed.toUpperCase();
  else if (typed.length === 1 && PUNCTUATION.has(typed)) key = typed;
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else {
    key = ({
      Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
      Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    } as Record<string, string>)[code] ?? canonicalKey(code);
  }
  if (!key) return null;
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push('Mod');
  if (mac && event.ctrlKey) parts.push('Ctrl');
  if (!mac && event.metaKey) return null;
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  return [...parts, key].join('+');
}

const MAC_GLYPHS: Readonly<Record<string, string>> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const KEY_GLYPHS: Readonly<Record<string, string>> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Escape: 'Esc', Plus: '+',
};

/**
 * A chord as the platform writes it: `⌥⌘T` on macOS, in the order the menu
 * bar uses (Control, Option, Shift, Command), and `Ctrl+Alt+T` elsewhere.
 */
export function displayChord(chord: string, mac: boolean): string {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  if (mac) {
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'].filter((name) => parts.includes(name));
    return order.map((name) => MAC_GLYPHS[name]).join('') + (KEY_GLYPHS[key] ?? key);
  }
  const names = parts.map((name) => (name === 'Mod' ? 'Ctrl' : name));
  return [...names, key.startsWith('Arrow') ? KEY_GLYPHS[key] : key].join('+');
}
