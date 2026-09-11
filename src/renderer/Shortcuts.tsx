/**
 * What Noto can do, and the keys that do it.
 *
 * The menus hold every command, and a menu is a poor place to learn from: a
 * reader who does not know a feature exists has no reason to open the menu
 * it lives on. Typora answers this with a reference under Help, and this is
 * the same idea for the things that are Noto's own as well as the ones it
 * borrows: the rail's views, the vault search, the opt-in graph Links view, PicGo, the
 * generated index blocks, the way pictures are resized.
 *
 * The list is written here rather than derived from the menu, because a
 * derived list would say `block-heading-1` where a person needs a sentence,
 * and because the things worth telling somebody about are not all commands.
 */

import { useEffect, useRef, useState } from 'react';

interface Entry {
  readonly keys: readonly string[];
  readonly what: string;
}

interface Group {
  readonly title: string;
  readonly entries: readonly Entry[];
}

const mod = (key: string, mac: boolean) => (mac ? `⌘${key}` : `Ctrl ${key}`);
const alt = (mac: boolean) => (mac ? '⌥' : 'Alt ');
const shift = (mac: boolean) => (mac ? '⇧' : 'Shift ');

export function shortcutGroups(mac: boolean): Group[] {
  return [
    {
      title: 'Finding your way',
      entries: [
        { keys: [mod('P', mac), mod('.', mac)], what: 'Quick open. Tab cycles files, folders and the text inside notes.' },
        { keys: ['Folders'], what: 'Choosing a folder narrows the other two tabs to it. Backspace on an empty box leaves it.' },
        { keys: ['type:', 'scope:'], what: 'Say what to search and where, in the box: type:content, scope:works/jobs. Tab finishes them.' },
        { keys: [mod('[', mac), mod(']', mac)], what: 'Narrow or widen quick open, which it remembers.' },
        { keys: ['[['], what: 'Typing two brackets asks which note you mean, and writes the link where they are.' },
        { keys: [shift(mac) + mod('F', mac)], what: 'Search the whole vault from the rail, and keep the results while you read.' },
        { keys: [mod('[', mac), mod(']', mac)], what: 'Back and forward along the notes you have read.' },
        { keys: [shift(mac) + mod('L', mac)], what: 'Show or hide the rail.' },
        { keys: [shift(mac) + mod('O', mac)], what: 'The outline of this note. A heading folds with the arrow keys.' },
        { keys: ['Links'], what: "Opt-in from Settings: the rail's Links view shows what links here, what this links to, and what the vault's graph thinks is near." },
        { keys: [shift(mac) + mod('T', mac)], what: 'Browse tags from every note\'s frontmatter, and open the notes that share one.' },
      ],
    },
    {
      title: 'Writing',
      entries: [
        { keys: [mod('/', mac)], what: 'Source Code Mode: the whole note as the text it is saved as.' },
        { keys: [alt(mac) + mod('/', mac)], what: 'Show one block as its markdown, and hide it again.' },
        { keys: [mod('D', mac), mod('L', mac)], what: 'Select the word, or the line, the caret is in.' },
        { keys: [mod('E', mac)], what: 'Select the styled run around the caret: the whole of a bold phrase.' },
        { keys: [shift(mac) + mod('V', mac)], what: 'Paste the text alone, read as markdown.' },
        { keys: [alt(mac) + '↑', alt(mac) + '↓'], what: 'Move the block, the list item, or the table row.' },
        { keys: [mod('=', mac), mod('-', mac)], what: 'Raise or lower the heading level.' },
      ],
    },
    {
      title: 'Tables and pictures',
      entries: [
        { keys: [alt(mac) + mod('T', mac)], what: 'Insert a table, asking how many rows and columns.' },
        { keys: ['Drag'], what: "A picture's corner resizes it, and the note keeps the zoom as Typora writes it." },
        { keys: ['Toolbar'], what: 'A table shows its own tools while the caret is in it: alignment, a row, a column, and away.' },
        { keys: ['Paste'], what: 'A pasted picture is filed beside the note, or sent to PicGo when the Images pane says so.' },
      ],
    },
    {
      title: 'The vault',
      entries: [
        { keys: ['Drag'], what: 'Drag a row onto a folder to move it. The vault row is a folder too.' },
        { keys: ['View menu'], what: 'Sort the tree by name or by when a note changed, and collapse it all.' },
        { keys: [shift(mac) + mod('T', mac)], what: 'Open again the note closed most recently.' },
        { keys: ['Themes'], what: 'The View menu lists the stylesheets in your themes folder, and opens the folder to add one.' },
        { keys: ['<!-- note-assistant:index -->'], what: 'A generated index block is drawn as its list of links, and its markdown is left alone.' },
        { keys: ['<!-- note-assistant:start -->'], what: 'An issued Related Notes block gets its own chrome (title, tags, reasons), distinct from a directory index.' },
        { keys: ['Remote'], what: 'A script on this machine can drive the editor once the Remote pane says so. Off until you switch it on.' },
      ],
    },
  ];
}

export interface ShortcutsProps {
  readonly mac: boolean;
  readonly onClose: () => void;
}

export function Shortcuts({ mac, onClose }: ShortcutsProps) {
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const wanted = query.trim().toLowerCase();
  const groups = shortcutGroups(mac)
    .map((group) => ({
      ...group,
      entries: wanted.length === 0
        ? group.entries
        : group.entries.filter((entry) =>
          entry.what.toLowerCase().includes(wanted) || entry.keys.join(' ').toLowerCase().includes(wanted)),
    }))
    .filter((group) => group.entries.length > 0);

  return (
    <div className="pref-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="shortcuts" role="dialog" aria-label="What Noto can do" data-testid="shortcuts-panel">
        <header className="shortcuts-header">
          <h2>What Noto can do</h2>
          <input
            ref={field}
            type="search"
            className="shortcuts-search"
            data-testid="shortcuts-search"
            placeholder="Search"
            aria-label="Search the list"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="pref-close" data-testid="shortcuts-close" onClick={onClose}>Done</button>
        </header>
        <div className="shortcuts-body">
          {groups.length === 0 && <p className="rail-empty">Nothing here matches that.</p>}
          {groups.map((group) => (
            <section key={group.title} className="shortcuts-group">
              <h3>{group.title}</h3>
              <dl>
                {group.entries.map((entry) => (
                  <div key={entry.what} className="shortcuts-row" data-testid="shortcuts-row">
                    <dt>{entry.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
                    <dd>{entry.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
