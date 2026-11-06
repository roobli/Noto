/**
 * The note in front of Quick Open's list, beside it: its name in the face it
 * is read in, the folder it is in and when it last changed, and its opening
 * as it reads, or, for a search inside notes, the lines around the match with
 * the match marked. It is how two notes with one name, or one opening, are
 * told apart before either is opened. Everything is drawn as text.
 */

import { useEffect, useMemo, useRef } from 'react';
import { previewBlocks, type PreviewBlock } from './quick-preview';

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
  /** For a match inside the note: its line, which the preview centres and marks. */
  readonly line: number | null;
}

const stripExtension = (name: string) => name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');

/** When it changed, as a person says it. */
function changedWords(modified: number, now = Date.now()): string {
  const day = (time: number) => { const at = new Date(time); at.setHours(0, 0, 0, 0); return at.getTime(); };
  const days = Math.round((day(now) - day(modified)) / 86_400_000);
  if (days <= 0) return 'changed today';
  if (days === 1) return 'changed yesterday';
  if (days < 7) return `changed ${days} days ago`;
  const then = new Date(modified);
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return `changed ${then.toLocaleDateString('en', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/** The words of `text` that are the query's, marked; the rest as it is. */
function Marked({ text, words }: { readonly text: string; readonly words: readonly string[] }) {
  if (words.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(pattern).map((part, index) => (index % 2 === 1
        // eslint-disable-next-line react/no-array-index-key -- the split's order is the identity
        ? <mark key={index} className="quick-preview-hit">{part}</mark>
        // eslint-disable-next-line react/no-array-index-key
        : <span key={index}>{part}</span>))}
    </>
  );
}

function Block({ block, hit, words }: { readonly block: PreviewBlock; readonly hit: boolean; readonly words: readonly string[] }) {
  const className = `quick-preview-${block.kind}${hit ? ' is-hit' : ''}`;
  if (block.kind === 'rule') return <hr className={className} />;
  const text = hit ? <Marked text={block.text} words={words} /> : block.text;
  return <p className={className} data-line={block.line}>{text}</p>;
}

export function QuickPreview({ target, value, query }: {
  readonly target: PreviewTarget;
  /** Undefined while it is being read; null when there is nothing to show. */
  readonly value: PreviewValue | null | undefined;
  readonly query: string;
}) {
  const title = stripExtension(target.name);
  const blocks = useMemo(() => {
    const all = value?.text ? previewBlocks(value.text, value.from, value.fence) : [];
    // The name is said above, in the title; a first heading that only says it again is left out.
    const first = all[0];
    const same = (left: string, right: string) => left.replace(/\s+/g, '').toLowerCase() === right.replace(/\s+/g, '').toLowerCase();
    return first && first.kind === 'h1' && value?.from === 1 && same(first.text, title) ? all.slice(1) : all;
  }, [value, title]);
  const words = useMemo(() => query.trim().split(/\s+/).filter((word) => word.length > 0 && !/^(type|scope):/i.test(word)), [query]);
  const body = useRef<HTMLDivElement>(null);
  const folders = target.relativePath.split('/').slice(0, -1);

  // A match is brought to the middle; a note's opening starts at its top.
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const hit = element.querySelector<HTMLElement>('.is-hit');
    element.scrollTop = hit ? Math.max(0, hit.offsetTop - element.clientHeight / 3) : 0;
  }, [blocks, target.line]);

  return (
    <aside className="quick-preview" data-testid="quick-preview" aria-label={`Preview of ${title}`}>
      <header className="quick-preview-head">
        <h3 className="quick-preview-title">{title}</h3>
        <p className="quick-preview-where" title={target.relativePath}>
          <span className="quick-preview-folder">{folders.length > 0 ? folders.slice(-3).join(' / ') : 'At the top of the folder'}</span>
          {value?.modified ? <span>{changedWords(value.modified)}</span> : null}
        </p>
      </header>
      <div className="quick-preview-body" ref={body} data-testid="quick-preview-body">
        {value === null && <p className="quick-preview-empty">Nothing of this note can be shown here.</p>}
        {value && blocks.length === 0 && <p className="quick-preview-empty">This note is empty.</p>}
        {blocks.map((block) => (
          <Block key={`${block.line}:${block.kind}`} block={block} hit={target.line !== null && block.line === target.line} words={words} />
        ))}
      </div>
    </aside>
  );
}
