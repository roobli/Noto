/**
 * An Electron accelerator as the reader's platform writes it: `⇧⌘P` on a Mac,
 * `Ctrl+Shift+P` elsewhere, so the command palette shows the same keys the
 * menu bar does.
 */

const MAC_ORDER = ['Control', 'Alt', 'Shift', 'Cmd'] as const;
const MAC_SIGN: Readonly<Record<string, string>> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' };
const KEY_SIGN: Readonly<Record<string, string>> = {
  Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Return: '↩', Backspace: '⌫', Delete: '⌦',
  Escape: 'Esc', Tab: '⇥', Space: 'Space', Plus: '+', PageUp: 'PgUp', PageDown: 'PgDn',
};

/** One modifier, normalised to the four a keyboard has. */
function modifier(part: string, mac: boolean): (typeof MAC_ORDER)[number] | null {
  switch (part.toLowerCase()) {
    case 'cmdorctrl': case 'commandorcontrol': return mac ? 'Cmd' : 'Control';
    case 'cmd': case 'command': case 'super': case 'meta': return 'Cmd';
    case 'ctrl': case 'control': return 'Control';
    case 'alt': case 'option': case 'altgr': return 'Alt';
    case 'shift': return 'Shift';
    default: return null;
  }
}

export function acceleratorLabel(accelerator: string, mac: boolean): string {
  const parts = accelerator.split('+');
  // A plus as the key itself is written `CmdOrCtrl+Plus` or leaves an empty part at the end.
  const key = parts.at(-1) === '' ? '+' : parts.at(-1)!;
  const held = new Set(parts.slice(0, -1).map((part) => modifier(part, mac)).filter((part) => part !== null));
  const shown = KEY_SIGN[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) return `${MAC_ORDER.filter((part) => held.has(part)).map((part) => MAC_SIGN[part]).join('')}${shown}`;
  const names: Readonly<Record<string, string>> = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Cmd: 'Win' };
  return [...(['Control', 'Alt', 'Shift', 'Cmd'] as const).filter((part) => held.has(part)).map((part) => names[part]), shown].join('+');
}
