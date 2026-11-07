/**
 * Review: the folder-wide queue, as a page in the rail beside Changes.
 *
 * What agents proposed, opened one file at a time in the diff view with
 * Accept and Reject in its bar; and what the tools found, by kind: links that
 * still point where a note used to be (always right, so Fix all), names a
 * note uses without linking, and notes read together with no link between
 * them, gone through one at a time with Y, N and S. Whatever is linked or
 * taken in is written to the notes at once, shows up in Changes to be
 * committed as usual, and Undo takes the last write back. Main leaves alone,
 * and names, any note with unsaved edits.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  DiffAction, RailPageHost, ReviewAnswer, ReviewDismissal, ReviewKind, ReviewProposal, ReviewSuggestion, ReviewSummary,
} from '../../slots';
import { absolute, nameOf } from './model';
import { acceptWords, fileChange, linkWords, proposalDetail, undoWords } from './review-words';
import { positionOf, step, type Queue } from './review-queue';

/** Suggestions fetched at a time for the queue. */
const PAGE = 40;

const STATE_WORDS: Record<string, string> = {
  'no-memory': 'This folder does not keep memory, so nothing waits here. Note Info offers to keep it.',
  untrusted: 'This folder’s memory runs scripts from its .noto/scripts folder, and Noto runs them only once you allow it.',
  opening: 'Reading the folder’s notes…',
  unavailable: 'The folder’s memory could not be read. Noto tries again in a little while.',
  outside: 'Open a folder to see what waits to be reviewed in it.',
};

const KINDS: readonly { readonly kind: ReviewKind; readonly title: string; readonly fix: boolean }[] = [
  { kind: 'stale', title: 'Links to moved notes', fix: true },
  { kind: 'mention', title: 'Named, not linked', fix: false },
  { kind: 'together', title: 'Read together', fix: false },
];

/** Where a note is, said only when it is in a folder of its own. */
const folderOf = (rel: string) => rel.split('/').slice(0, -1).join(' / ');

type Status = { readonly text: string; readonly undo: boolean } | null;

export function ReviewPage({ host }: { readonly host: RailPageHost }) {
  const review = host.review;
  const [summary, setSummary] = useState<ReviewAnswer<'summary'> | null>(null);
  const [counting, setCounting] = useState(false);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [dismissed, setDismissed] = useState<readonly ReviewDismissal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  /** Bumped when the folder changes: an answer about the one before is dropped. */
  const folder = useRef(0);

  // The cheap counts at once, then the mentions, which in a big folder take seconds on their own worker.
  const load = useCallback(() => {
    if (!review) return;
    const mine = ++latest.current;
    void review.ask({ kind: 'summary', counted: ['stale', 'together'] }).then((answer) => {
      if (mine !== latest.current) return;
      setSummary(answer);
      if (answer.state === 'ok' && answer.value && answer.value.counts.mention === null) {
        setCounting(true);
        void review.ask({ kind: 'summary', counted: ['mention'] }).then((full) => {
          if (mine !== latest.current) return;
          setCounting(false);
          if (full.state === 'ok') setSummary(full);
        }, () => setCounting(false));
      }
    }, () => {});
  }, [review]);

  useEffect(() => {
    load();
    // A save or a refresh can come in bursts; one ask after they settle.
    let pause: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (pause !== null) clearTimeout(pause); pause = setTimeout(() => { pause = null; load(); }, 250); };
    const stopMemory = review?.subscribe(soon) ?? (() => {});
    let where = host.folder();
    const stopHost = host.subscribe(() => {
      if (host.folder() === where) return;
      where = host.folder();
      folder.current += 1;
      setQueue(null);
      setStatus(null);
      setDismissed(null);
      // A proposal of the folder before has nothing to be accepted into here.
      host.showDiff(null);
      load();
    });
    return () => { if (pause !== null) clearTimeout(pause); stopMemory(); stopHost(); };
  }, [host, review, load]);

  if (!review) return <p className="rail-empty">Review needs the folder’s memory, which this plugin has not been allowed.</p>;
  if (summary === null) return null;
  if (summary.state !== 'ok' || !summary.value) {
    return (
      <div className="review-page" data-testid="review-page">
        <p className="rail-empty" data-testid="review-state" data-state={summary.state}>{STATE_WORDS[summary.state] ?? summary.error ?? ''}</p>
        {summary.state === 'untrusted' && host.vault && (
          <button type="button" className="info-button review-start" data-testid="review-trust"
            onClick={() => { void host.vault!.trust(); }}>Review Scripts…</button>
        )}
      </div>
    );
  }
  const value: ReviewSummary = summary.value;

  const undo = () => {
    setBusy(true);
    void review.ask({ kind: 'undo' }).then((answer) => {
      setBusy(false);
      setStatus({ text: answer.state === 'ok' ? undoWords(answer.value) : answer.error ?? 'That could not be taken back.', undo: false });
    }, () => setBusy(false));
  };

  /** Link every suggestion of a kind at once: only for stale links, which are always right. */
  const fixAll = async (kind: ReviewKind) => {
    const mine = folder.current;
    setBusy(true);
    const all: string[] = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const page = await review.ask({ kind: 'suggestions', type: kind, offset, limit: 200 });
      if (page.state !== 'ok' || !page.value) break;
      all.push(...page.value.items.map((item) => item.id));
      if (all.length >= page.value.total || page.value.items.length === 0) break;
    }
    // One write, so one Undo takes it all back.
    const answer = all.length > 0 && mine === folder.current ? await review.ask({ kind: 'link', type: kind, ids: all.slice(0, 5000) }) : null;
    setBusy(false);
    if (answer === null || mine !== folder.current) return;
    setStatus(answer.state === 'ok' && answer.value
      ? { text: linkWords(answer.value, all.length), undo: answer.value.linked.length > 0 }
      : { text: answer.error ?? 'The links could not be written.', undo: false });
  };

  const startQueue = async (kind: ReviewKind) => {
    const mine = folder.current;
    setBusy(true);
    const page = await review.ask({ kind: 'suggestions', type: kind, offset: 0, limit: PAGE });
    setBusy(false);
    if (mine !== folder.current) return;
    if (page.state === 'ok' && page.value) setQueue({ kind, items: page.value.items, total: page.value.total, index: 0, fetched: page.value.items.length });
  };

  /** The queue's own changes, dropped if the folder changed while they were on their way. */
  const queueFor = (mine: number) => (next: Queue | null) => { if (mine === folder.current) setQueue(next); };

  const showDismissed = () => {
    if (dismissed !== null) { setDismissed(null); return; }
    void review.ask({ kind: 'dismissals' }).then((answer) => { if (answer.state === 'ok' && answer.value) setDismissed(answer.value); });
  };

  const bringBack = (ids: readonly string[] | 'all') => {
    void review.ask({ kind: 'undismiss', ids }).then((answer) => {
      if (answer.state !== 'ok') return;
      setStatus({ text: `${answer.value!.count === 1 ? 'One suggestion comes' : `${answer.value!.count.toLocaleString('en')} suggestions come`} back.`, undo: false });
      setDismissed((current) => (current === null || ids === 'all' ? (ids === 'all' ? [] : current) : current.filter((item) => !ids.includes(item.id))));
    });
  };

  if (queue) {
    return (
      <QueueView host={host} queue={queue} setQueue={queueFor(folder.current)}
        onDone={(words) => { setQueue(null); if (words) setStatus(words); load(); }} />
    );
  }

  const waiting = value.proposals.length;
  return (
    <div className="review-page" data-testid="review-page" aria-busy={busy}>
      <section className="memory-group" aria-label="From agents" data-testid="review-proposals">
        <h3 className="memory-heading"><span>From agents</span><span className="memory-count">{waiting > 0 ? waiting : ''}</span></h3>
        {waiting === 0 && <p className="review-quiet">No proposals are waiting.</p>}
        <ul className="memory-list">
          {value.proposals.map((proposal) => (
            <li key={proposal.id}>
              <button type="button" className="memory-row" data-testid="review-proposal" data-id={proposal.id}
                onClick={() => openProposal(host, proposal, 0, setStatus)}>
                <span className="memory-title">{proposal.subject}</span>
                <span className="memory-why">{proposal.author} · {proposal.files.length === 1 ? nameOf(proposal.files[0]!.path) : `${proposal.files.length} notes`}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="memory-group" aria-label="Links to add" data-testid="review-links">
        <h3 className="memory-heading"><span>Links to add</span></h3>
        <ul className="memory-list">
          {KINDS.map(({ kind, title, fix }) => {
            const count = value.counts[kind];
            const known = count !== null;
            return (
              <li key={kind} className="review-kind" data-testid="review-kind" data-kind={kind}>
                <span className="review-kind-title">{title}</span>
                <span className="memory-count" data-testid="review-count">
                  {known ? count.toLocaleString('en') : kind === 'mention' && counting ? 'Counting…' : ''}
                </span>
                <button type="button" className="info-button review-kind-action" data-testid={fix ? 'review-fix-all' : 'review-start'}
                  disabled={busy || !known || count === 0}
                  onClick={() => { void (fix ? fixAll(kind) : startQueue(kind)); }}>
                  {fix ? 'Fix All' : 'Review'}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="memory-group" aria-label="Not this">
        <button type="button" className="review-dismissed-toggle" data-testid="review-dismissed" aria-expanded={dismissed !== null}
          disabled={value.dismissed === 0 && dismissed === null} onClick={showDismissed}>
          <span className={dismissed !== null ? 'tree-twisty tree-twisty-open' : 'tree-twisty'} aria-hidden="true" />
          Not this <span className="memory-count">{value.dismissed.toLocaleString('en')}</span>
        </button>
        {dismissed !== null && (
          <ul className="memory-list" data-testid="review-dismissed-list">
            {dismissed.map((item) => (
              <li key={item.id} className="review-dismissal" data-testid="review-dismissal">
                <span className="review-dismissal-words">{nameOf(item.from)} → {nameOf(item.to)}</span>
                <button type="button" className="review-text-button" onClick={() => bringBack([item.id])}>Bring Back</button>
              </li>
            ))}
            {dismissed.length > 1 && (
              <li><button type="button" className="review-text-button" onClick={() => bringBack('all')}>Bring All Back</button></li>
            )}
          </ul>
        )}
      </section>
      <StatusLine status={status} busy={busy} onUndo={undo} />
    </div>
  );
}

function StatusLine({ status, busy, onUndo }: { readonly status: Status; readonly busy: boolean; readonly onUndo: () => void }) {
  if (status === null) return null;
  return (
    <p className="info-status review-status" role="status" data-testid="review-status">
      {status.text}
      {status.undo && <> <button type="button" className="review-text-button" data-testid="review-undo" disabled={busy} onClick={onUndo}>Undo</button></>}
    </p>
  );
}

/**
 * One suggestion at a time, strongest first, the line shown as it will read
 * linked. Y links it at once, N says not this for good, S leaves it; Escape
 * or Done goes back to the list.
 */
function QueueView({ host, queue, setQueue, onDone }: {
  readonly host: RailPageHost;
  readonly queue: Queue;
  readonly setQueue: (queue: Queue | null) => void;
  readonly onDone: (status: Status) => void;
}) {
  const review = host.review!;
  const card = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const item = queue.items[queue.index] ?? null;
  const position = positionOf(queue);

  useEffect(() => { card.current?.focus(); }, []);

  /** On to the next one, fetching the next page when this one is used up (`review-queue.ts`). */
  const next = async (gone: boolean) => {
    const { queue: moved, fetch } = step(queue, gone);
    if (fetch === null) { setQueue(moved); return; }
    const page = await review.ask({ kind: 'suggestions', type: queue.kind, offset: fetch, limit: PAGE });
    if (page.state === 'ok' && page.value && page.value.items.length > 0) {
      setQueue({ kind: queue.kind, items: page.value.items, total: page.value.total, index: 0, fetched: fetch + page.value.items.length });
    } else setQueue(moved);
  };

  const link = async () => {
    if (!item || busy) return;
    setBusy(true);
    const answer = await review.ask({ kind: 'link', type: queue.kind, ids: [item.id] });
    setBusy(false);
    if (answer.state === 'ok' && answer.value) {
      setStatus({ text: linkWords(answer.value, 1), undo: answer.value.linked.length > 0 });
      if (answer.value.linked.length > 0 || answer.value.outdated.length > 0) await next(true);
    } else setStatus({ text: answer.error ?? 'It could not be linked.', undo: false });
  };

  const notThis = async () => {
    if (!item || busy) return;
    setBusy(true);
    const answer = await review.ask({ kind: 'dismiss', type: queue.kind, ids: [item.id] });
    setBusy(false);
    if (answer.state !== 'ok' || !answer.value) { setStatus({ text: answer.error ?? 'It could not be put aside.', undo: false }); return; }
    // Moved on only once it is kept, or is no longer suggested at all.
    if (answer.value.count > 0) { setStatus({ text: 'It will not be suggested again.', undo: false }); await next(true); }
    else if (answer.value.missing.includes(item.id)) { setStatus({ text: 'Its note changed, so it is no longer suggested.', undo: false }); await next(true); }
  };

  const undo = () => {
    setBusy(true);
    void review.ask({ kind: 'undo' }).then((answer) => {
      setBusy(false);
      setStatus({ text: answer.state === 'ok' ? undoWords(answer.value) : answer.error ?? 'That could not be taken back.', undo: false });
    }, () => setBusy(false));
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'y') { event.preventDefault(); void link(); }
    else if (key === 'n') { event.preventDefault(); void notThis(); }
    else if (key === 's') { event.preventDefault(); void next(false); }
    else if (event.key === 'Escape') { event.preventDefault(); onDone(status); }
  };

  const title = KINDS.find((entry) => entry.kind === queue.kind)?.title ?? '';
  return (
    <div className="review-page review-queue" data-testid="review-queue" ref={card} tabIndex={-1} onKeyDown={keys}
      role="group" aria-label={item ? `${title}: ${position} of ${queue.total}` : title}>
      <div className="review-queue-head">
        <button type="button" className="review-text-button" title="Back to Review (Esc)" onClick={() => onDone(status)} aria-keyshortcuts="Escape">‹ Review</button>
      </div>
      <h3 className="memory-heading review-queue-title">
        <span>{title}</span>
        <span className="memory-count" data-testid="review-position">{item ? `${position.toLocaleString('en')} of ${queue.total.toLocaleString('en')}` : ''}</span>
      </h3>
      {item === null ? (
        <p className="review-quiet" data-testid="review-queue-end">That is all of them.</p>
      ) : (
        <div className="review-card" data-testid="review-card" data-id={item.id}>
          <p className="review-where">
            <button type="button" className="memory-link" title={item.from}
              onClick={() => { const target = absolute(host.folder(), item.from); if (target) host.openNote(target); }}>
              {nameOf(item.from)}
            </button>
            {item.line !== null && <span className="memory-why"> · line {item.line.toLocaleString('en')}</span>}
          </p>
          {item.around ? (
            <p className="review-line" data-testid="review-line">
              {item.around[0]}<span className="review-linked">{item.around[1]}</span>{item.around[2]}
            </p>
          ) : (
            <p className="review-line memory-why">{item.reason}</p>
          )}
          <p className="review-to">
            → {item.toTitle || nameOf(item.to)}
            {folderOf(item.to) && <span className="memory-why"> in {folderOf(item.to)}</span>}
          </p>
          <div className="review-actions">
            <button type="button" className="info-button is-primary" data-testid="review-link" disabled={busy} aria-keyshortcuts="Y" onClick={() => { void link(); }}>
              Link It <kbd>Y</kbd>
            </button>
            <button type="button" className="info-button" data-testid="review-not-this" disabled={busy} aria-keyshortcuts="N" onClick={() => { void notThis(); }}>
              Not This <kbd>N</kbd>
            </button>
            <button type="button" className="info-button" data-testid="review-skip" disabled={busy} aria-keyshortcuts="S" onClick={() => { void next(false); }}>
              Skip <kbd>S</kbd>
            </button>
          </div>
        </div>
      )}
      <StatusLine status={status} busy={busy} onUndo={undo} />
    </div>
  );
}

/**
 * A proposal in the diff view, one file at a time: as it was when proposed
 * beside what is proposed, with Accept and Reject for the whole proposal and
 * the files stepped with [ and ]. Reject asks once more, since it is final.
 */
function openProposal(host: RailPageHost, proposal: ReviewProposal, index: number, setStatus: (status: Status) => void, confirming = false): void {
  const review = host.review!;
  const file = proposal.files[index];
  if (!file) return;
  void review.ask({ kind: 'proposal-file', proposal: proposal.id, path: file.path }).then((answer) => {
    if (answer.state !== 'ok' || !answer.value) {
      setStatus({ text: answer.error ?? 'The proposal could not be read.', undo: false });
      return;
    }
    const { base, proposed } = answer.value;
    const step = (to: number) => openProposal(host, proposal, to, setStatus);
    const actions: DiffAction[] = confirming
      ? [
        { id: 'reject-for-good', label: 'Reject for Good', title: 'Delete the proposal. Its changes are not taken in.', run: () => {
          void review.ask({ kind: 'reject', proposal: proposal.id }).then((done) => {
            if (done.state === 'ok') { host.showDiff(null); setStatus({ text: `Rejected “${proposal.subject}”.`, undo: false }); }
            else setStatus({ text: done.error ?? 'It could not be rejected.', undo: false });
          });
        } },
        { id: 'keep', label: 'Keep It', run: () => openProposal(host, proposal, index, setStatus) },
      ]
      : [
        { id: 'accept', label: 'Accept', title: 'Take every file of the proposal in, merged with what is there now (A)', run: () => {
          void review.ask({ kind: 'accept', proposal: proposal.id }).then((done) => {
            if (done.state !== 'ok' || !done.value) { setStatus({ text: done.error ?? 'It could not be taken in.', undo: false }); return; }
            const taken = done.value.applied.length > 0;
            if (done.value.conflicts.length === 0 && done.value.busy.length === 0) host.showDiff(null);
            setStatus({ text: acceptWords(done.value), undo: taken });
          });
        } },
        { id: 'reject', label: 'Reject…', title: 'Delete the proposal without taking it in', run: () => openProposal(host, proposal, index, setStatus, true) },
        { id: 'previous', label: 'Previous File', title: 'The file before ([)', unavailable: index === 0 ? 'This is the first file.' : undefined, run: () => step(index - 1) },
        { id: 'next', label: 'Next File', title: 'The file after (])', unavailable: index === proposal.files.length - 1 ? 'This is the last file.' : undefined, run: () => step(index + 1) },
      ];
    host.showDiff({
      title: proposal.subject,
      detail: `${proposalDetail(proposal, index)}${fileChange(file.status) === 'changed' ? '' : ` (${fileChange(file.status)})`}`,
      before: { label: base === null ? 'Not there yet' : 'As it was', text: base ?? '' },
      after: { label: proposed === null ? 'Deleted' : 'Proposed', text: proposed ?? '' },
      actions,
      keys: confirming ? {} : { '[': 'previous', ']': 'next', a: 'accept' },
    });
  });
}
