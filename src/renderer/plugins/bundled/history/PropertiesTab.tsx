/**
 * Properties: what the note says about itself, what is in it, and what git
 * and the file system know of it.
 *
 * Each group is named by where its values come from, because the question a
 * person asks of a property is often why it has the value it has. Today the
 * values come from the note's own frontmatter, its text, git and the file;
 * the vault's memory will add what a folder's policy or a script sets, under
 * its own heading.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { InfoTabHost, InfoTabView, NoteHistory, NoteMemory } from '../../slots';
import { frontmatterFields, plural, size, textCounts, when } from './model';

/** Where a value the memory holds came from. */
function originWords(from: string): string {
  switch (from) {
    case 'note': return 'written in the note';
    case 'script': return 'from a script';
    case 'folder': return 'from the folder\'s policy';
    case 'config': return 'from brain.yaml';
    default: return 'by default';
  }
}

/** "3 to notes, 1 to the web", or "None". */
function linkWords(notes: number, web: number): string {
  const parts = [notes > 0 ? `${notes.toLocaleString('en')} to ${notes === 1 ? 'a note' : 'notes'}` : '', web > 0 ? `${web.toLocaleString('en')} to the web` : ''];
  return parts.filter(Boolean).join(', ') || 'None';
}

/** "2 lines added, 1 taken away", leaving out a side with nothing on it. */
function changeWords(added: number, removed: number): string {
  if (removed === 0) return `${plural(added, 'line')} added`;
  if (added === 0) return `${plural(removed, 'line')} taken away`;
  return `${plural(added, 'line')} added, ${removed.toLocaleString('en')} taken away`;
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="properties-group" aria-label={title}>
      <h3 className="properties-heading">{title}</h3>
      <dl className="properties-list">{children}</dl>
    </section>
  );
}

function Row({ name, children, testId }: { readonly name: string; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <div className="properties-row" data-testid={testId ?? 'properties-row'} data-name={name}>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PropertiesTab({ host }: { readonly host: InfoTabHost }) {
  const [note, setNote] = useState(() => host.note());
  const [text, setText] = useState<string | null>(() => host.noteText());
  const [history, setHistory] = useState<NoteHistory | null>(null);
  const [copied, setCopied] = useState(false);
  const [memory, setMemory] = useState<NoteMemory | null>(null);

  useEffect(() => host.onNote(() => setNote(host.note())), [host]);
  useEffect(() => {
    setText(host.noteText());
    setHistory(null);
    if (note === null || !host.git) return undefined;
    let live = true;
    const read = () => {
      setText(host.noteText());
      host.git!.history(note).then((next) => { if (live) setHistory(next); }, () => { if (live) setHistory({ state: 'unavailable', commits: [], more: false, uncommitted: null, file: null }); });
    };
    read();
    // A save changes the marks: the counts and the dates follow it.
    const stop = host.git.subscribe(read);
    return () => { live = false; stop(); };
  }, [host, note]);

  // What the folder's memory makes of the note, and from where: the answer to
  // why an agent cannot read a note that says nothing about it.
  useEffect(() => {
    setMemory(null);
    if (note === null || !host.vault) return undefined;
    let live = true;
    // Only the latest question's answer counts: one asked on a change can come back before the first.
    let latest = 0;
    const ask = () => {
      const mine = ++latest;
      host.vault!.about(note).then((answer) => {
        if (live && mine === latest) setMemory(answer?.state === 'ok' ? answer.memory : null);
      }, () => {});
    };
    ask();
    const stop = host.vault.subscribe(ask);
    return () => { live = false; stop(); };
  }, [host, note]);

  if (note === null) return null;
  const fields = text === null ? [] : frontmatterFields(text);
  const counts = text === null ? null : textCounts(text);
  const commits = history?.commits ?? [];
  const folder = host.folder();
  const relative = folder && note.startsWith(folder) ? note.slice(folder.length).replace(/^[\\/]+/, '') : note;

  return (
    <div className="properties-tab" data-testid="properties-tab">
      {fields.length > 0 && (
        <Group title="In the note">
          {fields.map((field) => (
            <Row key={field.key} name={field.key} testId="properties-field">{field.value || <span className="properties-empty">empty</span>}</Row>
          ))}
        </Group>
      )}
      {memory && (
        <Group title="In the folder's memory">
          <Row name="Kind" testId="properties-memory">{memory.kind.value} <span className="properties-origin">{originWords(memory.kind.from)}</span></Row>
          <Row name="Known" testId="properties-memory">{memory.known.value ?? 'not said'} <span className="properties-origin">{originWords(memory.known.from)}</span></Row>
          <Row name="Sensitivity" testId="properties-memory">{memory.sensitivity.value} <span className="properties-origin">{originWords(memory.sensitivity.from)}</span></Row>
        </Group>
      )}
      {counts && (
        <Group title="Text">
          <Row name="Words">{counts.words.toLocaleString('en')}</Row>
          {counts.headings > 0 && <Row name="Headings">{counts.headings.toLocaleString('en')}</Row>}
          {counts.tables > 0 && <Row name="Tables">{counts.tables.toLocaleString('en')}</Row>}
          {counts.codeBlocks > 0 && <Row name="Code blocks">{counts.codeBlocks.toLocaleString('en')}</Row>}
          <Row name="Links">{linkWords(counts.noteLinks, counts.webLinks)}</Row>
        </Group>
      )}
      <Group title="Git">
        {history === null && <Row name="History">{host.git ? 'Reading…' : 'Not allowed'}</Row>}
        {history?.state === 'not-git' && <Row name="History">Not in git</Row>}
        {history?.state === 'untracked' && <Row name="History">Not committed yet</Row>}
        {(history?.state === 'slow' || history?.state === 'unavailable') && <Row name="History">Could not be read</Row>}
        {commits.length > 0 && (
          <>
            <Row name="First commit" testId="properties-first">{when(commits[commits.length - 1]!.time)}{history?.more ? ' or before' : ''}</Row>
            <Row name="Last commit">{when(commits[0]!.time)}</Row>
            <Row name="Commits">{commits.length.toLocaleString('en')}{history?.more ? '+' : ''}</Row>
          </>
        )}
        {history?.uncommitted && <Row name="Not committed">{changeWords(history.uncommitted.added, history.uncommitted.removed)}</Row>}
      </Group>
      <Group title="File">
        {history?.file && (
          <>
            <Row name="Created">{when(history.file.created)}</Row>
            <Row name="Changed">{when(history.file.modified)}</Row>
            <Row name="Size">{size(history.file.bytes)}</Row>
          </>
        )}
        <Row name="Path" testId="properties-path">
          {/* Broken after each folder, so a long path wraps at its slashes rather than mid-name. */}
          <span className="properties-path" title={note}>
            {relative.split('/').map((part, index, parts) => (
              <span key={index}>{part}{index < parts.length - 1 ? <>/<wbr /></> : null}</span>
            ))}
          </span>
          <button type="button" className="info-button properties-copy" data-testid="properties-copy-path"
            onClick={() => { host.copy(note); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </Row>
      </Group>
    </div>
  );
}

export function mountProperties(element: HTMLElement, host: InfoTabHost): InfoTabView {
  const root = createRoot(element);
  root.render(<PropertiesTab host={host} />);
  return { dispose: () => root.unmount() };
}
