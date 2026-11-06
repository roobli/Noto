/**
 * Related and Activity: what the folder's memory knows about the note in
 * front.
 *
 * Related is the notes worth having in mind while writing this one, in four
 * groups, each row saying why it is there so the reader can judge it: what
 * links here, notes this one names without linking, notes read or changed
 * together with it, and notes about the same thing. Above them, Ask the
 * Vault takes a question in words and answers with the folder's context
 * pack, which Copy as Context puts on the clipboard exactly as an agent
 * asking through MCP is given it. Activity is how the note
 * is used: who read it and how often, what led there, what was written to it,
 * its heat in a sentence, and which agents may not read it and why.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { InfoTabHost, InfoTabView, MemoryAskAnswer, NoteMemory, NoteMemoryAnswer } from '../../slots';
import { absolute, actorName, agentName, heatLevel, heatWords, nameOf, plainWhy, times, togetherWhy, useMemory } from './model';

/** Rows a group shows before it says how many more there are. */
const SHOWN = 8;
/** About the Same is a ranking, not a count: past a dozen its matches are weak, so it stops there. */
const ABOUT_SAME = 12;

function NotHere({ answer }: { readonly answer: NoteMemoryAnswer | null }) {
  if (answer === null) return null;
  const words: Record<string, string> = {
    'no-memory': 'This folder does not keep memory, so there is nothing here yet. A folder keeps memory when it has a .noto folder, which the vault tools make. History and Properties work without it.',
    untrusted: 'This folder’s memory runs scripts from its .noto/scripts folder, and Noto runs them only once you allow it. History and Properties work without them.',
    opening: 'Reading the folder’s notes. The first time, for a big folder, this takes a little while.',
    unknown: 'The memory does not hold this note yet. It is read once the note is saved.',
    unavailable: 'The folder’s memory could not be read. Noto tries again in a little while.',
    outside: 'This note is not in the open folder, so the folder’s memory has nothing to say about it.',
  };
  return <p className="info-note" data-testid="memory-state" data-state={answer.state}>{words[answer.state] ?? ''}</p>;
}

/**
 * A state with one thing to do about it: begin keeping memory, or allow the
 * folder's scripts. Main asks the question itself, in a sheet that says what
 * will be written or names the scripts, so the button here only starts it.
 */
function AskMain({ answer, label, testId, run }: {
  readonly answer: NoteMemoryAnswer;
  readonly label: string;
  readonly testId: string;
  readonly run: () => Promise<'done' | 'cancelled' | 'failed'>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="memory-keep" data-testid={testId}>
      <NotHere answer={answer} />
      <button type="button" className="info-button memory-keep-start" data-testid={`${testId}-start`} disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          void run().then((outcome) => { setBusy(false); setFailed(outcome === 'failed'); }, () => { setBusy(false); setFailed(true); });
        }}>
        {label}
      </button>
      {failed && <p className="info-status" role="status">That did not work. The folder may be read-only.</p>}
    </div>
  );
}

/**
 * One kind of relation: its name and how many, the first eight, and Show N
 * More for the rest the memory gave; past those, how many more the folder
 * holds, which are a search away rather than a scroll.
 */
function Group({ title, count, rows, testId }: { readonly title: string; readonly count: number; readonly rows: readonly ReactNode[]; readonly testId: string }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  const shown = open ? rows : rows.slice(0, SHOWN);
  const hidden = rows.length - shown.length;
  const unlisted = Math.max(0, count - rows.length);
  return (
    <section className="memory-group" aria-label={title} data-testid={testId}>
      <h3 className="memory-heading"><span>{title}</span><span className="memory-count">{count.toLocaleString('en')}</span></h3>
      <ul className="memory-list">
        {shown}
        {hidden > 0 && (
          <li>
            <button type="button" className="memory-more" data-testid="memory-show-more" onClick={() => setOpen(true)}>
              Show {hidden.toLocaleString('en')} more
            </button>
          </li>
        )}
        {hidden === 0 && unlisted > 0 && <li className="memory-more is-quiet">{unlisted.toLocaleString('en')} more in the folder</li>}
      </ul>
    </section>
  );
}

function Row({ host, rel, title, why, heat, testId }: {
  readonly host: InfoTabHost; readonly rel: string; readonly title: string; readonly why: ReactNode; readonly heat?: number; readonly testId: string;
}) {
  const target = absolute(host.folder(), rel);
  const level = heatLevel(heat);
  return (
    <li>
      <button type="button" className="memory-row" data-testid={testId} data-path={rel} title={rel}
        disabled={target === null} onClick={() => { if (target) host.openNote(target); }}>
        <span className="memory-title">{title || nameOf(rel)}</span>
        <span className="memory-why">{why}</span>
        {/* How warm it is, in three steps of ink: the accent marks only where you are. */}
        {level > 0 && <span className="memory-heat" data-level={level} aria-hidden="true"><i /><i /><i /></span>}
      </button>
    </li>
  );
}

/** Characters kept on each side of a mention: enough to place it, few enough that the name is always in view. */
const BEFORE = 8;
const AFTER = 14;

/** Where the note names the other one: a little on each side, the name itself in ink. */
function Mention({ around }: { readonly around: readonly [string, string, string] }) {
  const before = Array.from(around[0]);
  const after = Array.from(around[2]);
  return (
    <span className="memory-around" data-testid="memory-around">
      {before.length > BEFORE ? '…' : ''}{before.slice(-BEFORE).join('')}
      <span className="memory-name">{around[1]}</span>
      {after.slice(0, AFTER).join('')}{after.length > AFTER ? '…' : ''}
    </span>
  );
}

/** The tab's field, for a command that leads to it ("Ask the folder…"). */
const ASK_FOCUS = 'noto:memory-ask-focus';

/**
 * A question in words, and the folder's answer: the notes most likely to
 * matter, each with why it came up and an excerpt, within the memory's
 * budget. Copy as Context puts the same pack on the clipboard as Markdown.
 * Escape clears the answer; the question stays to be asked again.
 */
function Ask({ host, note }: { readonly host: InfoTabHost; readonly note: string }) {
  const [cue, setCue] = useState('');
  const [answer, setAnswer] = useState<MemoryAskAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const asked = useRef(0);
  useEffect(() => {
    const focus = () => { field.current?.focus(); field.current?.select(); };
    window.addEventListener(ASK_FOCUS, focus);
    return () => window.removeEventListener(ASK_FOCUS, focus);
  }, []);
  // A new note is a new conversation: what was asked from the last one is not about this one.
  useEffect(() => { setAnswer(null); setCopied(false); }, [note]);
  const ask = () => {
    const question = cue.trim();
    if (!question || !host.vault) return;
    const mine = ++asked.current;
    setBusy(true);
    setCopied(false);
    void host.vault.ask(question, note).then((reply) => {
      if (mine !== asked.current) return;
      setBusy(false);
      setAnswer(reply ?? { state: 'unavailable', value: null });
    }, () => { if (mine === asked.current) { setBusy(false); setAnswer({ state: 'unavailable', value: null }); } });
  };
  const pack = answer?.state === 'ok' ? answer.value : null;
  return (
    <div className="memory-ask" data-testid="memory-ask">
      <form role="search" className="memory-ask-form" onSubmit={(event) => { event.preventDefault(); ask(); }}>
        <svg className="memory-ask-glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" /></svg>
        <input ref={field} type="search" className="memory-ask-field" data-testid="memory-ask-field" value={cue}
          placeholder="Ask the vault…" aria-label="Ask the vault" spellCheck={false} maxLength={500}
          onChange={(event) => setCue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape' && answer) { event.preventDefault(); setAnswer(null); } }} />
        {cue.trim() !== '' && !busy && <kbd className="memory-ask-enter" aria-hidden="true">↩</kbd>}
      </form>
      {busy && <p className="info-status" role="status">Asking…</p>}
      {answer && !busy && !pack && <p className="info-status" role="status">The folder's memory could not be asked just now.</p>}
      {pack && !busy && (
        <section className="memory-group memory-asked" aria-label={`Asked: ${pack.cue}`} data-testid="memory-asked">
          <h3 className="memory-heading">
            <span>Asked</span>
            <button type="button" className="memory-link memory-copy" data-testid="memory-copy-context"
              disabled={pack.items.length === 0}
              onClick={() => { host.copy(pack.markdown); setCopied(true); }}>
              {copied ? 'Copied' : 'Copy as Context'}
            </button>
          </h3>
          <p className="memory-question" data-testid="memory-question">{pack.cue}</p>
          {pack.items.length === 0
            ? <p className="info-note">Nothing in the folder came up for that.</p>
            : (
              <ul className="memory-list">
                {pack.items.map((item) => (
                  <Row key={item.path} host={host} rel={item.path} title={item.title} testId="memory-asked-row"
                    why={<><span>{plainWhy(item.why, 'question')}</span><span className="memory-excerpt">{item.excerpt}</span></>} />
                ))}
                {pack.omitted > 0 && <li className="memory-more">{pack.omitted.toLocaleString('en')} more did not fit</li>}
              </ul>
            )}
        </section>
      )}
    </div>
  );
}

function Related({ host }: { readonly host: InfoTabHost }) {
  const { note, answer } = useMemory(host);
  const [brokenOpen, setBrokenOpen] = useState(false);
  if (note === null) return null;
  if (!host.vault) return <p className="info-note">Related needs the folder's memory, which this plugin has not been allowed.</p>;
  if (answer?.state === 'no-memory') {
    return <AskMain answer={answer} label="Keep Memory for This Folder…" testId="memory-keep"
      run={() => host.vault!.keep().then((outcome) => (outcome === 'made' ? 'done' : outcome))} />;
  }
  if (answer?.state === 'untrusted') {
    return <AskMain answer={answer} label="Review Scripts…" testId="memory-trust"
      run={() => host.vault!.trust().then((trusted) => (trusted ? 'done' : 'cancelled'))} />;
  }
  if (answer?.state !== 'ok' || !answer.memory) return <NotHere answer={answer} />;
  const memory = answer.memory;
  const listed = memory.linksHere.length + memory.namedHere.length + memory.together.length + memory.aboutSame.length;
  return (
    <div className="memory-tab" data-testid="related-tab">
      <Ask host={host} note={note} />
      {memory.supersededBy && (
        <p className="memory-superseded" data-testid="memory-superseded">
          Superseded by{' '}
          <button type="button" className="memory-link" onClick={() => {
            const target = absolute(host.folder(), memory.supersededBy!.path);
            if (target) host.openNote(target);
          }}>{memory.supersededBy.title || nameOf(memory.supersededBy.path)}</button>
        </p>
      )}
      <Group title="Links here" count={memory.linksHereCount} testId="related-links-here"
        rows={memory.linksHere.map((item) => (
          <Row key={item.path} host={host} rel={item.path} title={item.title} heat={item.heat} testId="related-row"
            why={[item.relation ? item.relation.replace(/_/g, ' ') : 'links here', item.reads > 0 ? `read ${times(item.reads)}` : ''].filter(Boolean).join(' · ')} />
        ))} />
      <Group title="Named here, not linked" count={memory.namedHereCount} testId="related-named-here"
        rows={memory.namedHere.map((item) => (
          <Row key={item.id} host={host} rel={item.to} title={item.title} testId="related-row"
            why={<Mention around={item.around} />} />
        ))} />
      <Group title="Read together" count={memory.togetherCount} testId="related-together"
        rows={memory.together.map((item) => (
          <Row key={`${item.path}:${item.type}`} host={host} rel={item.path} title={item.title} testId="related-row"
            why={togetherWhy(item.type, item.count)} />
        ))} />
      <Group title="About the same" count={Math.min(memory.aboutSame.length, ABOUT_SAME)} testId="related-about-same"
        rows={memory.aboutSame.slice(0, ABOUT_SAME).map((item) => (
          <Row key={item.path} host={host} rel={item.path} title={item.title} testId="related-row"
            why={plainWhy(item.why, 'title') || item.excerpt} />
        ))} />
      {listed === 0 && <p className="info-note" data-testid="related-nothing">Nothing else in the folder links to this note or is about the same thing yet.</p>}
      <div className="memory-outgoing" data-testid="related-outgoing">
        {memory.outgoing.count === 0 ? 'Links to no other note.' : `Links to ${memory.outgoing.count.toLocaleString('en')} ${memory.outgoing.count === 1 ? 'note' : 'notes'}`}
        {memory.outgoing.brokenCount > 0 && (
          <>
            {', '}
            <button type="button" className="memory-link" aria-expanded={brokenOpen} onClick={() => setBrokenOpen((open) => !open)}>
              {memory.outgoing.brokenCount.toLocaleString('en')} broken
            </button>
            {brokenOpen && (
              <ul className="memory-broken">
                {memory.outgoing.broken.map((item) => <li key={`${item.target}:${item.line}`}>{item.target} <span className="memory-why">line {item.line}</span></li>)}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Activity({ host }: { readonly host: InfoTabHost }) {
  const { note, answer } = useMemory(host);
  if (note === null) return null;
  if (!host.vault) return <p className="info-note">Activity needs the folder's memory, which this plugin has not been allowed.</p>;
  if (answer?.state !== 'ok' || !answer.memory) return <NotHere answer={answer} />;
  const memory: NoteMemory = answer.memory;
  return (
    <div className="memory-tab" data-testid="activity-tab">
      <section className="memory-group" aria-label="Read" data-testid="activity-reads" data-key="reads">
        <h3 className="memory-heading"><span>Read</span></h3>
        {memory.readers.length === 0 && <p className="memory-note">No one has opened it since the folder began keeping memory.</p>}
        <dl className="properties-list">
          {memory.readers.map((reader) => (
            <div key={reader.actor} className="properties-row" data-testid="activity-reader">
              <dt>{actorName(reader.actor)}</dt>
              <dd>{times(reader.count)}, last {new Date(reader.last).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</dd>
            </div>
          ))}
        </dl>
      </section>
      {memory.agents.length > 0 && (
        <section className="memory-group" aria-label="Agents" data-testid="activity-agents">
          <h3 className="memory-heading"><span>Agents</span></h3>
          <dl className="properties-list">
            {memory.agents.map((agent) => (
              <div key={agent.name} className="properties-row" data-testid={agent.canSee ? 'activity-allowed' : 'activity-barred'}>
                <dt title={agentName(agent.name)}>{agentName(agent.name)}</dt>
                {agent.canSee
                  ? <dd>may read it</dd>
                  : <dd className="memory-reason">cannot read it{agent.why ? `: ${agent.why}` : ''}</dd>}
              </div>
            ))}
          </dl>
        </section>
      )}
      {memory.leadsHere.length > 0 && (
        <section className="memory-group" aria-label="What leads here">
          <h3 className="memory-heading"><span>What leads here</span></h3>
          <ul className="memory-list">
            {memory.leadsHere.map((item) => (item.from
              ? <Row key={`from:${item.from}`} host={host} rel={item.from} title={nameOf(item.from)} why={`opened from it ${times(item.count)}`} testId="activity-lead" />
              : <li key={`query:${item.query}`} className="memory-plain" data-testid="activity-lead">Searched “{item.query}” <span className="memory-why">{times(item.count)}</span></li>))}
          </ul>
        </section>
      )}
      <section className="memory-group" aria-label="Written" data-testid="activity-writes">
        <h3 className="memory-heading"><span>Written</span></h3>
        {/* Rows like Read's. Git cannot say who made a change, so its count is git's, not the person's;
            an agent that says it wrote here is named under it. */}
        <dl className="properties-list">
          <div className="properties-row" data-testid="activity-commits">
            <dt>In git</dt>
            <dd>
              {memory.writes.commits === 0 ? 'no commits' : `${memory.writes.commits.toLocaleString('en')} ${memory.writes.commits === 1 ? 'commit' : 'commits'}`}
              {memory.writes.appends > 0 ? `, ${memory.writes.appends.toLocaleString('en')} added by agents` : ''}
            </dd>
          </div>
          {memory.writes.agents.map((writer) => (
            <div key={writer.actor} className="properties-row" data-testid="activity-writer">
              <dt title={agentName(writer.actor)}>{agentName(writer.actor)}</dt>
              <dd>wrote it {times(writer.count)}, last {new Date(writer.last).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="memory-heat-words" data-testid="activity-heat">{heatWords(memory)}</p>
    </div>
  );
}

function mount(Component: typeof Related, element: HTMLElement, host: InfoTabHost): InfoTabView {
  const root = createRoot(element);
  root.render(<Component host={host} />);
  return {
    reveal: (key) => {
      // `ask`: the field, for a command that leads here; it may mount a moment after.
      if (key === 'ask') {
        const focus = () => window.dispatchEvent(new Event(ASK_FOCUS));
        if (element.querySelector('[data-testid="memory-ask-field"]')) focus();
        else setTimeout(focus, 120);
        return;
      }
      element.querySelector<HTMLElement>('[data-key="reads"]')?.scrollIntoView({ block: 'nearest' });
    },
    dispose: () => root.unmount(),
  };
}

export const mountRelated = (element: HTMLElement, host: InfoTabHost) => mount(Related, element, host);
export const mountActivity = (element: HTMLElement, host: InfoTabHost) => mount(Activity, element, host);
