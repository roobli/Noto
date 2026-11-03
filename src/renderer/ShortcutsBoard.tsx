import { useEffect, useMemo, useState } from 'react';
import { NOTO_SETTINGS_VERSION, type MenuShortcutV1 } from '../shared/settings/v1/contracts';
import { displayChord } from '../shared/shortcuts/chord';
import { isComposing } from './ime';
import { buildShortcutRows, conflictsOf, groupRank, sourceText, type PluginHotkeySource, type ShortcutRow } from './shortcuts/catalog';

export interface ShortcutsBoardProps {
  readonly mac: boolean;
  readonly disabled: readonly string[];
  readonly plugins: readonly PluginHotkeySource[];
  /**
   * Applied to the list as it stands when the change lands, not as this
   * render saw it: two switches flipped before the first write returns must
   * both stay flipped.
   */
  readonly onChange: (change: (disabled: readonly string[]) => readonly string[]) => void;
}

/**
 * Every key the app answers to, where it comes from, and a switch for each.
 *
 * Grouped by the menu each lives in, then the keys that live in the page and
 * the plugins'. A switch turns the chord off wherever it is bound, so the key
 * goes back to the system or the app beside this one. A row the app cannot do
 * without, or the operating system owns, says so instead of offering a switch.
 */
export function ShortcutsBoard({ mac, disabled, plugins, onChange }: ShortcutsBoardProps) {
  const [menu, setMenu] = useState<readonly MenuShortcutV1[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    void window.notoSettings.listShortcuts({ version: NOTO_SETTINGS_VERSION, requestId: `shortcuts:${crypto.randomUUID()}` })
      .then((result) => {
        if (!live) return;
        if (result.ok) setMenu(result.value.menu);
        else setUnreadable(true);
      })
      .catch(() => { if (live) setUnreadable(true); });
    return () => { live = false; };
  }, []);

  const rows = useMemo(() => buildShortcutRows({ menu: menu ?? [], plugins, mac }), [menu, plugins, mac]);
  const conflicts = useMemo(() => conflictsOf(rows), [rows]);
  const off = useMemo(() => new Set(disabled), [disabled]);

  const needle = query.trim().toLowerCase();
  const shown = needle.length === 0 ? rows : rows.filter((row) =>
    [row.label, row.group, sourceText(row), displayChord(row.chord, mac), row.chord]
      .some((text) => text.toLowerCase().includes(needle)));
  const groups = new Map<string, ShortcutRow[]>();
  for (const row of [...shown].sort((a, b) => groupRank(a.group) - groupRank(b.group))) {
    groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  }
  const offCount = rows.filter((row) => !row.locked && off.has(row.chord)).length;

  const toggle = (row: ShortcutRow, on: boolean) => {
    onChange((current) => {
      const next = new Set(current);
      if (on) next.delete(row.chord);
      else next.add(row.chord);
      return [...next];
    });
  };

  return (
    <>
      <div className="shortcut-tools">
        <input
          type="search"
          className="shortcut-search"
          data-testid="shortcut-search"
          placeholder="Find a shortcut by name, key or source"
          aria-label="Find a shortcut"
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isComposing(event)) return;
            if (event.key === 'Escape' && query.length > 0) { event.stopPropagation(); setQuery(''); }
          }}
        />
        <span className="shortcut-count" data-testid="shortcut-count">
          {rows.length} shortcuts{offCount > 0 ? `, ${offCount} off` : ''}
        </span>
        {offCount > 0 && (
          <button type="button" className="pref-action" data-testid="shortcut-reset" onClick={() => onChange(() => [])}>
            Turn all back on
          </button>
        )}
      </div>
      {unreadable && (
        <p className="pref-note">The menu&apos;s shortcuts could not be read, so only the editor&apos;s and the plugins&apos; are listed.</p>
      )}
      {menu === null && !unreadable && <p className="pref-note">Reading the menu&hellip;</p>}
      {shown.length === 0 && <p className="pref-note" data-testid="shortcut-no-match">No shortcut matches &ldquo;{query.trim()}&rdquo;.</p>}
      {[...groups].map(([group, members]) => [
        <p key={`group:${group}`} className="pref-group">{group}</p>,
        ...members.map((row) => <ShortcutLine key={row.key} row={row} mac={mac}
          on={!off.has(row.chord)} sharedWith={conflicts.get(row.key)} onToggle={toggle} />),
      ])}
    </>
  );
}

function ShortcutLine({ row, mac, on, sharedWith, onToggle }: {
  row: ShortcutRow;
  mac: boolean;
  on: boolean;
  sharedWith: readonly string[] | undefined;
  onToggle: (row: ShortcutRow, on: boolean) => void;
}) {
  const notes = [sourceText(row)];
  if (row.hidden) notes.push('not shown in the menu');
  if (row.locked) notes.push('always on');
  const keys = <kbd className="shortcut-keys" data-off={String(!row.locked && !on)}>{displayChord(row.chord, mac)}</kbd>;
  const label = (
    <span className="pref-label">
      <span className="shortcut-name">{row.label}</span>
      <small>
        {notes.join(', ')}
        {sharedWith && <span className="shortcut-clash" data-testid="shortcut-clash">. Shares its key with {sharedWith.join(', ')}</span>}
      </small>
    </span>
  );
  if (row.locked) {
    return (
      <div className="pref-row shortcut-row is-locked" data-testid="shortcut-row" data-chord={row.chord}>
        {label}
        {keys}
      </div>
    );
  }
  return (
    <label className={`pref-row pref-switch shortcut-row${on ? '' : ' is-off'}`} data-testid="shortcut-row" data-chord={row.chord}>
      {label}
      {keys}
      <input
        type="checkbox"
        role="switch"
        aria-label={`${row.label}, ${displayChord(row.chord, mac)}`}
        data-testid="shortcut-switch"
        checked={on}
        onChange={(event) => onToggle(row, event.target.checked)}
      />
      <span className="pref-track" aria-hidden="true" />
    </label>
  );
}
