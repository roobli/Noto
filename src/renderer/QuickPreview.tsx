/**
 * The note in front of Quick Open's list, beside it.
 *
 * One of two ways, and nothing half way: Rendered is the note as the page
 * sets it, through the editor's own parser and stylesheet
 * (`quick-preview-render.ts`), so what is shown is what opens; Source is the
 * file as written, every byte, numbered. Above either, one quiet line says
 * where the note lives and when it changed, which is how two notes of one
 * name are told apart. A search inside notes scrolls the preview to the line
 * it found and marks it.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { QuickOpenPreviewV1 } from '../shared/settings/v1/contracts';
import { renderNotePreview } from './quick-preview-render';

export interface PreviewValue {
  readonly text: string | null;
  readonly from: number;
  readonly modified: number | null;
  /** The fence of a code block the text begins inside, or null. */
  readonly fence: string | null;
}

export interface PreviewTarget {
  readonly path: string;
  readonly name: string;
  readonly relativePath: string;
  /** For a match inside the note: its line, which the preview brings into view and marks. */
  readonly line: number | null;
}

/** When it changed, as a person says it, short: the list's age column says it the same way. */
export function changedWords(modified: number, now = Date.now()): string {
  const day = (time: number) => { const at = new Date(time); at.setHours(0, 0, 0, 0); return at.getTime(); };
  const minutes = Math.round((now - modified) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const days = Math.round((day(now) - day(modified)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d`;
  const then = new Date(modified);
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString('en', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The folders a note is in, top first, joined as the list joins them. */
export function folderWords(relativePath: string): string {
  const folders = relativePath.split('/').slice(0, -1);
  return folders.length > 0 ? folders.join(' / ') : 'At the top of the folder';
}

/**
 * The window of text main sent, as markdown that parses as the page would:
 * a window that begins inside a code block gets that block's fence back, so
 * the rest of the note is not read as code.
 */
function windowText(value: PreviewValue): string {
  const text = value.text ?? '';
  return value.fence ? `${value.fence}\n${text}` : text;
}

function RenderedView({ value, line, words }: { readonly value: PreviewValue; readonly line: number | null; readonly words: readonly string[] }) {
  const host = useRef<HTMLDivElement>(null);
  const text = windowText(value);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    element.replaceChildren(renderNotePreview(text, element.ownerDocument));
    if (line === null) { element.parentElement!.scrollTop = 0; return; }
    // The line a search found: marked where its words are, and brought to a third of the way down.
    const mark = markWords(element, words);
    const scroller = element.parentElement!;
    if (mark) {
      const top = mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
    }
  }, [text, line, words]);
  return <div className="ProseMirror quick-preview-doc" ref={host} />;
}

/** Wrap the first run of the query's words in a mark; returns it. Text nodes only, so nothing is parsed. */
function markWords(root: HTMLElement, words: readonly string[]): HTMLElement | null {
  if (words.length === 0) return null;
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const found = pattern.exec(node.data);
    if (!found) continue;
    const hit = node.splitText(found.index);
    hit.splitText(found[0].length);
    const mark = root.ownerDocument.createElement('mark');
    mark.className = 'quick-preview-hit';
    hit.replaceWith(mark);
    mark.append(hit);
    return mark;
  }
  return null;
}

function SourceView({ value, line }: { readonly value: PreviewValue; readonly line: number | null }) {
  const list = useRef<HTMLOListElement>(null);
  const lines = useMemo(() => (value.text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n'), [value.text]);
  useEffect(() => {
    const scroller = list.current?.parentElement;
    if (!scroller) return;
    const hit = line === null ? null : list.current!.querySelector<HTMLElement>('.is-hit');
    scroller.scrollTop = hit ? Math.max(0, hit.offsetTop - scroller.clientHeight / 3) : 0;
  }, [lines, line]);
  return (
    <ol className="quick-preview-source" ref={list} start={value.from} style={{ ['--from' as string]: value.from }}>
      {lines.map((text, index) => (
        // eslint-disable-next-line react/no-array-index-key -- a line's number is its identity here
        <li key={index} className={line !== null && value.from + index === line ? 'is-hit' : undefined}>
          <span>{text.length > 0 ? text : '\u00a0'}</span>
        </li>
      ))}
    </ol>
  );
}

export function QuickPreview({ target, value, query, view }: {
  readonly target: PreviewTarget;
  /** Undefined while it is being read; null when there is nothing to show. */
  readonly value: PreviewValue | null | undefined;
  readonly query: string;
  readonly view: QuickOpenPreviewV1;
}) {
  const words = useMemo(() => query.trim().split(/\s+/).filter((word) => word.length > 0 && !/^(type|scope):/i.test(word)), [query]);
  const title = target.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
  return (
    <aside className="quick-preview" data-testid="quick-preview" data-view={view} aria-label={`Preview of ${title}`}>
      <div className="quick-preview-measure">
        <header className="quick-preview-head">
          <span className="quick-preview-where" title={target.relativePath}><bdi>{folderWords(target.relativePath)}</bdi></span>
          {value?.modified ? <span className="quick-preview-when">{changedWords(value.modified)}</span> : null}
        </header>
        <div className="quick-preview-body" data-testid="quick-preview-body">
          {value === null && <p className="quick-preview-empty">Nothing of this note can be shown here.</p>}
          {value && !(value.text ?? '').trim() && <p className="quick-preview-empty">This note is empty.</p>}
          {value && (value.text ?? '').trim() && (view === 'source'
            ? <SourceView value={value} line={target.line} />
            : <RenderedView value={value} line={target.line} words={words} />)}
        </div>
      </div>
    </aside>
  );
}
