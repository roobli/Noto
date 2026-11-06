/**
 * Settings → Memory: who may read the open folder, what they may do, and
 * the memory itself.
 *
 * The agents its `.noto/access.yaml` names, each with what it reads, what it
 * may do, and when it last read anything; whoever brings no key is listed
 * too, since that is what any agent on this computer gets. Adding an agent
 * asks three plain questions, then main asks once more in a sheet of its own
 * and the key is shown here once, with the setup to paste where the agent
 * runs. Taking a key back stops the agent at its next request.
 *
 * Below the agents, the memory: what its index holds and building it again,
 * whether this computer keeps the read record, and stopping keeping memory,
 * which main asks about in a sheet that says what `.noto` holds before it
 * goes to the Trash.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  AgentRowV1, WorkspaceAgentActionV1, WorkspaceAgentsReplyV1, WorkspaceMemoryFolderActionV1, WorkspaceMemoryFolderReplyV1,
} from '../shared/workspace/v1/contracts';
import { copyThroughSelection } from './editor/noto/clipboard';
import { claudeCodeHook, claudeCodeSetup, codexSetup, indexWords, reachWords } from './memory-setup';
import { Switch } from './PrefSwitch';

const rid = () => `memory-agents:${crypto.randomUUID()}`;

const when = (at: string) => new Date(at).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });

function describe(agent: AgentRowV1): string {
  if (agent.revoked && agent.keys === 0 && agent.name !== 'default') return `Key taken back ${when(agent.revoked)}`;
  if (agent.name === 'default' && agent.verbs.length === 0) return 'Turned off: agents without a key read nothing';
  const reads = agent.reads === 'private' ? 'Open and private notes' : 'Open notes';
  const last = agent.lastRead ? ` · last read ${when(agent.lastRead)}` : agent.name === 'default' ? '' : ' · has not read anything yet';
  return `${reads} · ${reachWords(agent.verbs, agent.writes)}${last}`;
}

export function MemoryPane() {
  const [reply, setReply] = useState<WorkspaceAgentsReplyV1 | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [reads, setReads] = useState<'open' | 'private'>('open');
  const [may, setMay] = useState<'read' | 'propose' | 'write'>('read');
  const [writeIn, setWriteIn] = useState('');
  const [added, setAdded] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [memory, setMemory] = useState<WorkspaceMemoryFolderReplyV1 | null>(null);

  const ask = useCallback(async (action: WorkspaceAgentActionV1) => {
    const result = await window.notoWorkspace.memoryAgents({ version: 1, requestId: rid(), action });
    if (result.ok) setReply(result.value);
    return result.ok ? result.value : null;
  }, []);

  const askMemory = useCallback(async (action: WorkspaceMemoryFolderActionV1) => {
    const result = await window.notoWorkspace.memoryFolder({ version: 1, requestId: rid(), action });
    if (result.ok) setMemory(result.value);
  }, []);

  useEffect(() => {
    void ask({ kind: 'list' });
    void askMemory({ kind: 'status' });
    return window.notoWorkspace.onMemoryChanged(() => {
      void ask({ kind: 'list' });
      void askMemory({ kind: 'status' });
    });
  }, [ask, askMemory]);

  if (reply === null) return null;
  if (reply.state === 'outside') return <p className="pref-note" data-testid="memory-pane-state">Open a folder to choose who may read it.</p>;
  if (reply.state === 'no-memory') {
    return <p className="pref-note" data-testid="memory-pane-state">This folder does not keep memory, so no agent reads it. Note Info offers to keep it.</p>;
  }

  const copy = (what: string, text: string) => {
    copyThroughSelection(text);
    setCopied(what);
    window.setTimeout(() => setCopied((current) => (current === what ? null : current)), 1500);
  };
  const wildcard = /[*?]/.test(writeIn);
  const valid = /^[A-Za-z0-9._-]{1,64}$/.test(name) && !['default', 'owner', '__proto__', 'constructor', 'prototype'].includes(name)
    && (may !== 'write' || (writeIn.trim() !== '' && !wildcard));

  const add = async () => {
    setBusy(true);
    const answer = await ask({ kind: 'add', name, reads, may, writeIn: may === 'write' ? writeIn.trim() : null });
    setBusy(false);
    if (answer?.outcome === 'done' && answer.key) {
      setAdded({ name, key: answer.key });
      setAdding(false);
      setName('');
      setWriteIn('');
    }
  };

  return (
    <div className="memory-pane" data-testid="memory-pane">
      <p className="pref-note">
        Agents reach this folder&apos;s memory through its MCP server, each with a key that says what it may read and do.
        Sealed notes are never given to any of them.
      </p>
      <p className="pref-group">Agents</p>
      <ul className="memory-agents" data-testid="memory-agents">
        {reply.agents.map((agent) => {
          const active = agent.name === 'default' ? agent.verbs.length > 0 : agent.keys > 0;
          return (
            <li key={agent.name} className={active ? 'memory-agent' : 'memory-agent is-off'} data-testid="memory-agent" data-name={agent.name}>
              {/* A mark per agent, its initial, so a list of keys reads as
                  who rather than as rows of text; whoever brings no key is
                  the wildcard. Dimmed while it reads nothing. */}
              <span className="memory-agent-mark" aria-hidden="true">{agent.name === 'default' ? '*' : agent.name.slice(0, 1).toUpperCase()}</span>
              <span className="memory-agent-name">{agent.name === 'default' ? 'Any agent without a key' : agent.name}</span>
              <span className="memory-agent-words">{describe(agent)}</span>
              {active && (
                <button type="button" className="pref-inline-action" data-testid="memory-agent-revoke" disabled={busy}
                  onClick={() => { void ask({ kind: 'revoke', name: agent.name }); }}>
                  {agent.name === 'default' ? 'Turn Off' : 'Take Key Back…'}
                </button>
              )}
            </li>
          );
        })}
        {!adding && !added && (
          <li className="memory-agent-add">
            <button type="button" data-testid="memory-add-agent" onClick={() => setAdding(true)}>
              <span className="memory-agent-mark" aria-hidden="true">+</span>
              Add an Agent…
            </button>
          </li>
        )}
      </ul>

      {added && reply.setup && (
        <div className="memory-key" data-testid="memory-key" role="group" aria-label={`${added.name}'s key`}>
          <p className="pref-status">{added.name}&apos;s key, shown this once:</p>
          <code className="memory-key-text" data-testid="memory-key-text">{added.key}</code>
          <div className="memory-key-actions">
            <button type="button" className="pref-inline-action" data-testid="memory-copy-claude" onClick={() => copy('claude', claudeCodeSetup(reply.setup!, added.key))}>
              {copied === 'claude' ? 'Copied' : 'Copy Setup for Claude Code'}
            </button>
            <button type="button" className="pref-inline-action" data-testid="memory-copy-codex" onClick={() => copy('codex', codexSetup(reply.setup!, added.key))}>
              {copied === 'codex' ? 'Copied' : 'Copy Setup for Codex'}
            </button>
            <button type="button" className="pref-inline-action" onClick={() => copy('key', added.key)}>{copied === 'key' ? 'Copied' : 'Copy Key'}</button>
          </div>
          <p className="pref-note">
            For Claude Code, run the copied line where Claude Code runs. For Codex, add the copied block to ~/.codex/config.toml.
            Either needs Node.js 22.13 or later on this computer. The key then lives in that agent&apos;s own settings file.
            Once you leave this page it is not shown again here; take it back and add the agent again for a new one.
          </p>
          <button type="button" className="pref-inline-action" onClick={() => setAdded(null)}>Done</button>
        </div>
      )}

      {reply.setup && (
        <>
          <p className="pref-group">Edits an agent makes itself</p>
          <div className="pref-row">
            <span className="pref-label">
              Claude Code hook
              <small>
                Git keeps every change to a note but not who made it, so an agent that edits files with its own tools looks like you.
                With this hook, Claude Code says which notes it read and wrote, and Note Info names it under Activity. Nothing is added to your commits.
              </small>
            </span>
            <button type="button" className="pref-inline-action" data-testid="memory-copy-hook" onClick={() => copy('hook', claudeCodeHook(reply.setup!))}>
              {copied === 'hook' ? 'Copied' : 'Copy Hook'}
            </button>
          </div>
          <p className="pref-note">
            Merge it into ~/.claude/settings.json. It records only notes in a folder that keeps memory, takes about 30 ms an edit, and never stops the agent&apos;s step.
            Any other agent can run the same command line itself: node, the script, then record write and the note&apos;s path.
          </p>
        </>
      )}
      {adding && (
        <form className="memory-add" data-testid="memory-add-form" onSubmit={(event) => { event.preventDefault(); if (valid && !busy) void add(); }}>
          <label className="memory-add-field">
            <span className="pref-label">What is it called?</span>
            <input data-testid="memory-add-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="claude-code"
              spellCheck={false} autoFocus aria-describedby="memory-add-name-hint" />
            <span className="pref-note" id="memory-add-name-hint">Letters, digits, dots, dashes and underscores.</span>
          </label>
          <fieldset className="memory-add-field">
            <legend className="pref-label">Which notes may it read?</legend>
            <label><input type="radio" name="memory-reads" checked={reads === 'open'} onChange={() => setReads('open')} /> Open notes only</label>
            <label><input type="radio" name="memory-reads" data-testid="memory-add-private" checked={reads === 'private'} onChange={() => setReads('private')} /> Private notes too</label>
          </fieldset>
          <fieldset className="memory-add-field">
            <legend className="pref-label">What may it do?</legend>
            <label><input type="radio" name="memory-may" checked={may === 'read'} onChange={() => setMay('read')} /> Read and search</label>
            <label><input type="radio" name="memory-may" data-testid="memory-add-propose" checked={may === 'propose'} onChange={() => setMay('propose')} /> Also propose changes, for you to review</label>
            <label><input type="radio" name="memory-may" data-testid="memory-add-write" checked={may === 'write'} onChange={() => setMay('write')} /> Also write directly in one folder</label>
            {may === 'write' && (
              <input data-testid="memory-add-write-in" value={writeIn} onChange={(event) => setWriteIn(event.target.value)}
                placeholder="Daily" spellCheck={false} aria-label="The folder it writes in" aria-invalid={wildcard} />
            )}
            {may === 'write' && wildcard && <span className="pref-note" role="status">One folder by its name: * and ? would make it a pattern.</span>}
          </fieldset>
          {reply.outcome === 'failed' && reply.error && <p className="pref-problem" role="status">{reply.error}</p>}
          <div className="memory-key-actions">
            <button type="submit" className="pref-inline-action" data-testid="memory-add-submit" disabled={!valid || busy}>Add Agent…</button>
            <button type="button" className="pref-inline-action" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}

      {memory && memory.state !== 'outside' && memory.state !== 'no-memory' && (
        <>
          <p className="pref-group">This folder&apos;s memory</p>
          <div className="pref-row" data-testid="memory-index">
            <span className="pref-label">
              Index
              <small data-testid="memory-index-words">{indexWords(memory.state, memory.index)}</small>
            </span>
            <button type="button" className="pref-inline-action" data-testid="memory-rebuild"
              disabled={memory.state === 'opening' || memory.state === 'untrusted'}
              onClick={() => { void askMemory({ kind: 'rebuild' }); }}>
              Rebuild Index
            </button>
          </div>
          <Switch
            label="Keep a record of the notes I open"
            hint="On this computer only. Heat, Activity and Related come from it. What agents read is recorded by their server either way."
            checked={memory.recording}
            // The switch moves when pressed; main's answer then settles it.
            onChange={(on) => { setMemory({ ...memory, recording: on }); void askMemory({ kind: 'record', on }); }}
            testId="memory-record"
          />
          <div className="pref-row">
            <span className="pref-label">
              Stop keeping memory
              <small>Moves this folder&apos;s .noto to the Trash, after saying what is in it. Your notes are not touched.</small>
            </span>
            <button type="button" className="pref-inline-action is-danger" data-testid="memory-turn-off"
              onClick={() => { void askMemory({ kind: 'turn-off' }); }}>
              Stop Keeping Memory…
            </button>
          </div>
          {memory.outcome === 'failed' && memory.error && <p className="pref-problem" role="status">{memory.error}</p>}
        </>
      )}
    </div>
  );
}
