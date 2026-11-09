/**
 * The note's unsaved changes, against the file as saved.
 *
 * Opened from the note's name in the title bar while it has unsaved changes,
 * or from the command palette, and laid over the page until it is closed. It
 * edits nothing: it is a reading of `unsaved-diff.ts`, which pairs the blocks.
 *
 * Three layouts of the same rows. Side by side keeps the two in one scroll,
 * so a block and its counterpart are always level. Stacked puts the saved file
 * above and the note below, each scrolling on its own; a change pointed at in
 * one is lit in the other, and stepping to a change brings both to it. Inline
 * is one text, what went struck through and what came marked, where each
 * happened. In all three a change is one thing: pointed at, it lights wherever
 * it is drawn, and stepping through the changes visits each in turn.
 *
 * Long runs of unchanged blocks fold to a line that opens on a press, keeping
 * two blocks of context either side of every change.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DiffLayoutV1 } from '../shared/settings/v1/contracts';
import { unsavedDiff, wordDiff, type DiffRow, type WordPiece } from './unsaved-diff';

const LAYOUTS: readonly { readonly value: DiffLayoutV1; readonly label: string }[] = [
  { value: 'side', label: 'Side by side' },
  { value: 'stacked', label: 'Stacked' },
  { value: 'inline', label: 'Inline' },
];

/** Unchanged blocks kept either side of a change before the rest folds. */
const CONTEXT = 2;

type Item =
  | { readonly type: 'row'; readonly row: DiffRow; readonly index: number }
  | { readonly type: 'fold'; readonly from: number; readonly count: number };

function itemsOf(rows: readonly DiffRow[], opened: ReadonlySet<number>): Item[] {
  const items: Item[] = [];
  let at = 0;
  while (at < rows.length) {
    if (rows[at]!.kind !== 'same') {
      items.push({ type: 'row', row: rows[at]!, index: at });
      at += 1;
      continue;
    }
    let end = at;
    while (end < rows.length && rows[end]!.kind === 'same') end += 1;
    const foldFrom = at === 0 ? 0 : at + CONTEXT;
    const foldTo = end === rows.length ? end : end - CONTEXT;
    const fold = foldTo - foldFrom >= 2 && !opened.has(foldFrom);
    for (let index = at; index < end; index += 1) {
      if (fold && index === foldFrom) items.push({ type: 'fold', from: foldFrom, count: foldTo - foldFrom });
      if (fold && index >= foldFrom && index < foldTo) continue;
      items.push({ type: 'row', row: rows[index]!, index });
    }
    at = end;
  }
  return items;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function summary(diff: ReturnType<typeof unsavedDiff>): string {
  if (diff.changes === 0) return diff.spacingOnly ? 'Spacing only' : 'No changes';
  const parts = [
    diff.modified > 0 ? `${diff.modified} edited` : '',
    diff.added > 0 ? `${diff.added} added` : '',
    diff.removed > 0 ? `${diff.removed} removed` : '',
  ].filter(Boolean);
  return `${plural(diff.changes, 'change', 'changes')}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`;
}

/** An edited block's words, as one side sees them or, for inline, both. */
function Words({ pieces, show }: { readonly pieces: readonly WordPiece[]; readonly show: 'saved' | 'current' | 'both' }) {
  return (
    <>
      {pieces.map((piece, index) => {
        if (piece.op === 'same') return <span key={index}>{piece.text}</span>;
        if (piece.op === 'removed' && show !== 'current') return <del key={index} className="diff-word-removed">{piece.text}</del>;
        if (piece.op === 'added' && show !== 'saved') return <ins key={index} className="diff-word-added">{piece.text}</ins>;
        return null;
      })}
    </>
  );
}

interface BlockProps {
  readonly tone: 'same' | 'removed' | 'added';
  readonly change: number;
  readonly linked: boolean;
  readonly active: boolean;
  readonly children: ReactNode;
}

/** One block's source, marked as kept, gone or new. */
function Block({ tone, change, linked, active, children }: BlockProps) {
  const sign = tone === 'removed' ? '−' : tone === 'added' ? '+' : '';
  return (
    <div
      className={`diff-block is-${tone}${linked ? ' is-linked' : ''}${active ? ' is-active' : ''}`}
      data-change={change >= 0 ? change : undefined}
    >
      <span className="diff-sign" aria-hidden="true">{sign}</span>
      <div className="diff-text">
        {tone !== 'same' && <span className="diff-hidden">{tone === 'removed' ? 'Removed: ' : 'Added: '}</span>}
        {children}
      </div>
    </div>
  );
}

/** Where a block was added or removed, in the pane that does not have it. */
function Gap({ change, linked, active, tone, label }: { readonly change: number; readonly linked: boolean; readonly active: boolean; readonly tone: 'added' | 'removed'; readonly label: string }) {
  return (
    <div className={`diff-gap is-${tone}${linked ? ' is-linked' : ''}${active ? ' is-active' : ''}`} data-change={change}>
      <span>{label}</span>
    </div>
  );
}

/** A button in the bar, for a view of two versions: Older, Restore This Version. */
export interface DiffBarAction {
  readonly id: string;
  readonly label: string;
  readonly title?: string;
  /** Why it cannot run now; shown disabled, with this as its tooltip. */
  readonly unavailable?: string;
  readonly run: () => void;
}

/**
 * Two versions of a note rather than its unsaved changes: from the info
 * pane's history, say. The view is the same; its words and buttons differ.
 */
export interface DiffVersions {
  readonly title: string;
  readonly detail?: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
  readonly actions?: readonly DiffBarAction[];
  /** A bare key that runs an action, by its id. */
  readonly keys?: Readonly<Record<string, string>>;
}

export interface UnsavedDiffProps {
  readonly fileName: string;
  readonly saved: string;
  readonly current: string;
  readonly layout: DiffLayoutV1;
  readonly onLayout: (layout: DiffLayoutV1) => void;
  readonly onClose: () => void;
  readonly versions?: DiffVersions;
}

export function UnsavedDiff({ fileName, saved, current, layout, onLayout, onClose, versions }: UnsavedDiffProps) {
  const beforeLabel = versions?.beforeLabel ?? 'Saved';
  const afterLabel = versions?.afterLabel ?? 'Now';
  const diff = useMemo(() => unsavedDiff(saved, current), [saved, current]);
  const words = useMemo(() => diff.rows.map((row) => (row.kind === 'modified' ? wordDiff(row.saved!, row.current!) : null)), [diff]);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const items = useMemo(() => itemsOf(diff.rows, opened), [diff, opened]);
  const [active, setActive] = useState(diff.changes > 0 ? 0 : -1);
  const [hovered, setHovered] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);

  useEffect(() => { rootRef.current?.focus(); }, []);

  // Bring the active change to the middle of every pane that draws it. Each
  // pane is scrolled on its own rather than with `scrollIntoView`, which
  // would also move the page behind the view. Smooth, unless the reader asked
  // for less motion: a jump is what left them not knowing where they were.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || active < 0) return;
    const smooth = !firstScroll.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    firstScroll.current = false;
    for (const pane of root.querySelectorAll<HTMLElement>('.diff-scroll')) {
      const target = pane.querySelector<HTMLElement>(`[data-change="${active}"]`);
      if (!target) continue;
      const offset = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
      const top = Math.max(0, offset - pane.clientHeight / 2 + Math.min(target.offsetHeight, pane.clientHeight) / 2);
      pane.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    }
  }, [active, layout]);

  const step = (direction: 1 | -1) => {
    if (diff.changes === 0) return;
    setActive((current) => (current + direction + diff.changes) % diff.changes);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    // A bare letter only: with a modifier it is a chord for the menu, Print
    // among them, and is left to it.
    const bare = !event.ctrlKey && !event.metaKey && !event.altKey;
    const named = bare ? versions?.keys?.[event.key] : undefined;
    const action = named ? versions?.actions?.find((candidate) => candidate.id === named) : undefined;
    if (action) {
      event.preventDefault();
      if (!action.unavailable) action.run();
      return;
    }
    if ((bare && event.key === 'n') || (event.altKey && event.key === 'ArrowDown')) {
      event.preventDefault();
      step(1);
    } else if ((bare && event.key === 'p') || (event.altKey && event.key === 'ArrowUp')) {
      event.preventDefault();
      step(-1);
    }
  };

  const pointAt = (target: EventTarget | null) => {
    const element = target instanceof Element ? target.closest<HTMLElement>('[data-change]') : null;
    setHovered(element ? Number(element.dataset.change) : -1);
  };

  const fold = (item: Extract<Item, { type: 'fold' }>, key: string) => (
    <button key={key} type="button" className="diff-fold" onClick={() => setOpened((set) => new Set(set).add(item.from))}>
      {plural(item.count, 'unchanged block', 'unchanged blocks')}
    </button>
  );

  const flags = (row: DiffRow) => ({ change: row.change, linked: row.change >= 0 && row.change === hovered, active: row.change >= 0 && row.change === active });

  /** One side of a row, as that side's pane draws it. */
  const side = (row: DiffRow, index: number, which: 'saved' | 'current', withGaps: boolean): ReactNode => {
    const text = which === 'saved' ? row.saved : row.current;
    if (row.kind === 'same') return <Block tone="same" {...flags(row)}>{text}</Block>;
    if (text === null) {
      if (!withGaps) return <div className="diff-filler" aria-hidden="true" />;
      return which === 'saved'
        ? <Gap {...flags(row)} tone="added" label={versions ? `added by ${afterLabel}` : 'added in the note'} />
        : <Gap {...flags(row)} tone="removed" label={versions ? `not in ${afterLabel}` : 'removed from the note'} />;
    }
    const tone = which === 'saved' ? 'removed' : 'added';
    const pieces = words[index];
    return <Block tone={tone} {...flags(row)}>{pieces ? <Words pieces={pieces} show={which} /> : text}</Block>;
  };

  const body = (() => {
    if (diff.changes === 0) {
      return (
        <p className="diff-empty" data-testid="unsaved-diff-empty">
          {versions
            ? (diff.spacingOnly ? 'Only the spacing between blocks, or how the file ends, differs.' : 'The two versions read the same.')
            : diff.spacingOnly
              ? 'Only the spacing between blocks, or how the file ends, differs from the saved file. Saving writes it.'
              : 'Nothing differs from the saved file.'}
        </p>
      );
    }
    if (layout === 'side') {
      return (
        <div className="diff-scroll diff-side">
          <div className="diff-pair diff-heads" aria-hidden="true"><span>{beforeLabel}</span><span>{afterLabel}</span></div>
          {items.map((item) => (item.type === 'fold'
            ? fold(item, `f${item.from}`)
            : (
              <div key={item.index} className={`diff-pair is-${item.row.kind}`}>
                {side(item.row, item.index, 'saved', false)}
                {side(item.row, item.index, 'current', false)}
              </div>
            )))}
        </div>
      );
    }
    if (layout === 'stacked') {
      return (
        <div className="diff-stack">
          {(['saved', 'current'] as const).map((which) => (
            <section key={which} className="diff-pane" aria-label={which === 'saved' ? beforeLabel : afterLabel}>
              <div className="diff-pane-head">{which === 'saved' ? beforeLabel : afterLabel}</div>
              <div className="diff-scroll">
                {items.map((item) => (item.type === 'fold'
                  ? fold(item, `${which}f${item.from}`)
                  : <div key={`${which}${item.index}`}>{side(item.row, item.index, which, true)}</div>))}
              </div>
            </section>
          ))}
        </div>
      );
    }
    return (
      <div className="diff-scroll diff-inline">
        {items.map((item) => {
          if (item.type === 'fold') return fold(item, `f${item.from}`);
          const { row, index } = item;
          if (row.kind === 'same') return <Block key={index} tone="same" {...flags(row)}>{row.current}</Block>;
          if (row.kind === 'removed') return <Block key={index} tone="removed" {...flags(row)}><del>{row.saved}</del></Block>;
          if (row.kind === 'added') return <Block key={index} tone="added" {...flags(row)}>{row.current}</Block>;
          return (
            <div key={index} className={`diff-block is-modified${flags(row).linked ? ' is-linked' : ''}${flags(row).active ? ' is-active' : ''}`} data-change={row.change}>
              <span className="diff-sign" aria-hidden="true">~</span>
              <div className="diff-text"><span className="diff-hidden">Edited: </span><Words pieces={words[index]!} show="both" /></div>
            </div>
          );
        })}
      </div>
    );
  })();

  return (
    <div
      ref={rootRef}
      className={`unsaved-diff${versions ? ' is-versions' : ''}`}
      data-testid={versions ? 'version-diff' : 'unsaved-diff'}
      data-layout={layout}
      role="dialog"
      aria-label={versions ? `${versions.title}, ${fileName}` : `Unsaved changes to ${fileName}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseOver={(event) => pointAt(event.target)}
      onMouseLeave={() => setHovered(-1)}
    >
      <header className="diff-bar">
        <div className="diff-title">
          <strong title={versions?.title}>{versions ? versions.title : 'Unsaved changes'}</strong>
          {versions?.detail && <span className="diff-detail" data-testid="version-diff-detail" title={versions.detail}>{versions.detail}</span>}
          <span className="diff-summary" data-testid="unsaved-diff-summary">{summary(diff)}</span>
        </div>

        {diff.changes > 0 && (
          <div className="diff-nav" role="group" aria-label="Changes">
            <button type="button" className="icon-button" data-testid="unsaved-diff-previous"
              aria-label="Previous change" title="Previous change (P)" onClick={() => step(-1)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.75 10 8 5.75 12.25 10" /></svg>
            </button>
            <span className="diff-count" aria-live="polite" data-testid="unsaved-diff-count">{active + 1} of {diff.changes}</span>
            <button type="button" className="icon-button" data-testid="unsaved-diff-next"
              aria-label="Next change" title="Next change (N)" onClick={() => step(1)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.75 6 8 10.25 12.25 6" /></svg>
            </button>
          </div>
        )}
        <div className="diff-layouts" role="group" aria-label="Layout">
          {LAYOUTS.map((option) => (
            <button key={option.value} type="button" className="diff-layout" data-testid={`unsaved-diff-layout-${option.value}`}
              aria-pressed={layout === option.value} onClick={() => onLayout(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-button" data-testid="unsaved-diff-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 4.25 11.75 11.75M11.75 4.25 4.25 11.75" /></svg>
        </button>
      </header>
      {/* What can be done with the version: a row of its own under the bar, so
          the title keeps its room and the buttons never stack. */}
      {versions?.actions && versions.actions.length > 0 && (
        <div className="diff-actions" role="toolbar" aria-label="Version">
          {versions.actions.map((action) => (
            <button key={action.id} type="button" className="diff-action" data-testid={`version-diff-${action.id}`}
              disabled={Boolean(action.unavailable)} title={action.unavailable ?? action.title} onClick={action.run}>
              {action.label}
            </button>
          ))}
        </div>
      )}
      {body}
    </div>
  );
}
