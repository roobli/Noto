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
 *
 * It is also the guide: an entry says what it needs where not every folder
 * has it, a Try It button leads to it or does it, and what came after the
 * edition last looked at is marked New and gathered at the top.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Raised whenever entries are added: someone who has looked before sees the
 * new ones marked New, gathered at the top, and the title bar's ? carries a
 * dot until the list is opened again.
 */
export const GUIDE_EDITION = 3;

/** What a Try It button does: the window leads there, or does it. */
export type GuideTry =
  | 'note-info' | 'note-history' | 'ask' | 'review' | 'changes' | 'folder-info' | 'settings-memory'
  | 'outline' | 'search' | 'quick-open' | 'palette';

interface Entry {
  readonly keys: readonly string[];
  readonly what: string;
  /** What it needs, where not every folder has it. */
  readonly needs?: string;
  /** The edition of this list it came in; the first is 1. */
  readonly since?: number;
  readonly tryIt?: GuideTry;
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
        { keys: [mod('P', mac), mod('.', mac)], what: 'Quick open. Tab cycles files, folders and the text inside notes.', tryIt: 'quick-open' },
        { keys: [shift(mac) + mod('P', mac)], what: 'The command palette: every command, by name, with its key.', tryIt: 'palette' },
        { keys: ['Folders'], what: 'Choosing a folder narrows the other two tabs to it. Backspace on an empty box leaves it.' },
        { keys: ['type:', 'scope:'], what: 'Say what to search and where, in the box: type:content, scope:works/jobs. Tab finishes them.' },
        { keys: [mod('[', mac), mod(']', mac)], what: 'Narrow or widen quick open, which it remembers.' },
        { keys: ['[['], what: 'Typing two brackets asks which note you mean, and writes the link where they are.' },
        { keys: [shift(mac) + mod('F', mac)], what: 'Search the whole vault from the rail, and keep the results while you read.', tryIt: 'search' },
        { keys: [alt(mac) + mod('←', mac), alt(mac) + mod('→', mac)], what: 'Back and forward along the notes you have read.' },
        { keys: [shift(mac) + mod('L', mac)], what: 'Show or hide the rail.' },
        { keys: [shift(mac) + mod('O', mac)], what: 'The outline of this note. A heading folds with the arrow keys.', tryIt: 'outline' },
        { keys: ['Links'], what: "Opt-in from Settings: the rail's Links view shows what links here, what this links to, and what the vault's graph thinks is near." },
        { keys: [alt(mac) + shift(mac) + mod('T', mac)], what: 'Browse tags from every note\'s frontmatter, and open the notes that share one.' },
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
      title: 'Note Info, beside the page',
      entries: [
        { keys: ['Get Info'], what: 'Right-click a note, or View → Note Info: its timeline of commits and reads, and tabs for History, Properties, Related and Activity.', since: 2, tryIt: 'note-info' },
        { keys: ['Earlier · date'], what: "A note older than a year draws its last year on the timeline, and everything before as one grey mark. Press the axis's left end for all of its time.", since: 3, tryIt: 'note-info' },
        { keys: ['History'], what: 'Every commit that touched the note, through renames. Press one for the diff; [ and ] step through, Restore This Version takes it back as one edit Undo reverses.', needs: 'The folder is in git.', since: 2, tryIt: 'note-history' },
        { keys: ['Right-click'], what: 'History of This Passage, on a paragraph: only the commits that changed those lines, followed where they moved.', needs: 'The folder is in git.', since: 2 },
        { keys: ['Properties'], what: "The note's frontmatter, its words, links and code, its first and last commit, and what the folder's memory says it is.", since: 2 },
      ],
    },
    {
      title: "The folder's memory",
      entries: [
        { keys: ['Related'], what: 'The notes worth having in mind while writing this one, each with why: what links here, what it names without linking, what is read with it, what is about the same.', needs: 'The folder keeps memory (it has a .noto folder).', since: 2, tryIt: 'note-info' },
        { keys: ['Ask the vault'], what: 'A question in words, at the top of Related, answered with the notes that matter and a few lines of each. Copy as Context gives the Markdown an agent gets.', needs: 'The folder keeps memory.', since: 2, tryIt: 'ask' },
        { keys: ['Dotted underline', alt(mac) + '↩'], what: 'A name of another note you did not link. Rest on it, or press the keys with the caret in it: Link writes the link, Not This says no for good.', needs: 'The folder keeps memory.', since: 2 },
        { keys: ['Review'], what: "The rail's queue: agents' proposals in the diff view, links to moved notes to fix at once, names to link one by one with Y, N and S.", needs: 'The folder keeps memory.', since: 2, tryIt: 'review' },
        { keys: ['Get Info on a folder'], what: 'Right-click a folder: how many notes and broken links, the warmest, the newest commits, what is read most and what nothing links to.', since: 2, tryIt: 'folder-info' },
        { keys: ['Privacy'], what: 'Right-click a folder: open, private (only agents allowed private notes) or sealed (no agent, ever). The tree shows a lock.', needs: 'The folder keeps memory.', since: 2 },
        { keys: ['Settings → Memory'], what: 'Who may read this folder: add an agent with a key and copy its setup for Claude Code or Codex, take a key back, rebuild the index.', since: 2, tryIt: 'settings-memory' },
        { keys: ['Copy Hook for Claude Code'], what: 'In Settings → Memory: Claude Code then says which notes it read and wrote with its own tools, and Activity names it under Written instead of counting it as you.', needs: 'The folder keeps memory, and Node.js 22.13 or later.', since: 3, tryIt: 'settings-memory' },
      ],
    },
    {
      title: 'Moving notes',
      entries: [
        { keys: ['Drag'], what: 'Drag a row onto a folder, or onto a note to put it in that note\'s folder. Hold at the top or bottom edge to scroll; hold over a closed folder to open it.', since: 2 },
        { keys: [mod('click', mac), shift(mac) + 'click'], what: 'Choose several rows; drag one to move them all, or right-click for Move and Trash. Escape lets them go.', since: 2 },
        { keys: ['Links follow'], what: 'Rename or move a note or folder and the links to it are written again. The status line says how many, with Undo.', since: 2 },
        { keys: ['Changes'], what: "The rail's list of notes that differ from the last commit, as a short tree.", needs: 'The folder is in git.', tryIt: 'changes' },
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
        { keys: ['View menu'], what: 'Sort the tree by name or by when a note changed, and collapse it all.' },
        { keys: [shift(mac) + mod('T', mac)], what: 'Open again the note closed most recently.' },
        { keys: ['Themes'], what: 'The View menu lists the stylesheets in your themes folder, and opens the folder to add one.' },
        { keys: ['<!-- note-assistant:index -->'], what: 'A generated index block is drawn as its list of links, and its markdown is left alone.' },
        { keys: ['<!-- note-assistant:start -->'], what: 'An issued Related Notes block gets its own chrome (title, tags, reasons), distinct from a directory index.' },
        { keys: ['Shortcuts'], what: 'Every key the app answers to, where it comes from, and a switch to turn one off, in Settings.' },
        { keys: ['Remote'], what: 'A script on this machine can drive the editor once the Remote pane says so. Off until you switch it on.' },
      ],
    },
  ];
}

export interface ShortcutsProps {
  readonly mac: boolean;
  readonly onClose: () => void;
  /** The edition last looked at: what came after is marked New, and gathered at the top. */
  readonly seen?: number;
  /** Do what an entry's Try It says; the list closes first. */
  readonly onTry?: (action: GuideTry) => void;
}

const TRY_WORDS: Record<GuideTry, string> = {
  'note-info': 'Show Me', 'note-history': 'Show Me', ask: 'Try It', review: 'Show Me', changes: 'Show Me',
  'folder-info': 'Show Me', 'settings-memory': 'Show Me', outline: 'Show Me', search: 'Try It', 'quick-open': 'Try It', palette: 'Try It',
};

export function Shortcuts({ mac, onClose, seen = GUIDE_EDITION, onTry }: ShortcutsProps) {
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
  const all = shortcutGroups(mac);
  const fresh = all.flatMap((group) => group.entries.filter((entry) => (entry.since ?? 1) > seen));
  const groups = (fresh.length > 0 ? [{ title: 'New since you last looked', entries: fresh }, ...all] : all)
    .map((group) => ({
      ...group,
      entries: wanted.length === 0
        ? group.entries
        : group.entries.filter((entry) =>
          entry.what.toLowerCase().includes(wanted) || entry.keys.join(' ').toLowerCase().includes(wanted)),
    }))
    .filter((group) => group.entries.length > 0);

  return (
    <div className="guide-scrim" data-testid="shortcuts-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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
                  <div key={entry.what} className="shortcuts-row" data-testid="shortcuts-row" data-new={(entry.since ?? 1) > seen || undefined}>
                    <dt>{entry.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
                    <dd>
                      <span className="shortcuts-what">
                        {(entry.since ?? 1) > seen && <span className="shortcuts-new">New</span>}
                        {entry.what}
                      </span>
                      {entry.needs && <span className="shortcuts-needs">{entry.needs}</span>}
                      {entry.tryIt && onTry && (
                        <button type="button" className="shortcuts-try" data-testid="shortcuts-try" data-try={entry.tryIt}
                          onClick={() => { onClose(); onTry(entry.tryIt!); }}>
                          {TRY_WORDS[entry.tryIt]}
                        </button>
                      )}
                    </dd>
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
