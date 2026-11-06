/**
 * What Settings → Memory copies for an agent, and what main accepts from it:
 * one server per folder, quoted for a shell or written as TOML so a path
 * with spaces or quotes survives the paste; and an agent request only in the
 * shape it can take.
 */

import { describe, expect, it } from 'vitest';
import { agoWords, claudeCodeSetup, codexSetup, indexWords, reachWords, serverName } from '../../src/renderer/memory-setup';
import { isWorkspaceAgentRequestV1, isWorkspaceAgentsReplyV1 } from '../../src/shared/workspace/v1/validate';

const setup = { script: '/Applications/Noto.app/Contents/Resources/app.asar.unpacked/.vite/build/noto-vault.js', root: "/Users/me/My Notes/RooB's" };

describe('the setup an agent is given', () => {
  it('names one server per folder', () => {
    expect(serverName('/Users/me/RooB')).toBe('noto-roob');
    expect(serverName('/Users/me/笔记/')).toBe('noto-vault');
    expect(serverName('C:\\Users\\me\\Work Notes')).toBe('noto-work-notes');
  });

  it('quotes what a shell would split, for Claude Code', () => {
    const line = claudeCodeSetup(setup, 'k3y_value-1');
    expect(line).toBe(`claude mcp add noto-roob-s --scope user --env 'NOTO_VAULT_ROOT=/Users/me/My Notes/RooB'\\''s' --env NOTO_VAULT_KEY=k3y_value-1 -- node ${setup.script} mcp`);
  });

  it('writes TOML Codex reads, with the same three things', () => {
    const block = codexSetup(setup, 'k3y');
    expect(block).toContain('[mcp_servers.noto-roob-s]');
    expect(block).toContain('command = "node"');
    expect(block).toContain(`args = ["${setup.script}", "mcp"]`);
    expect(block).toContain(`NOTO_VAULT_ROOT = "/Users/me/My Notes/RooB's"`);
    expect(block).toContain('NOTO_VAULT_KEY = "k3y"');
  });

  it('says what an agent may do in a few words', () => {
    expect(reachWords(['read', 'search', 'recall'], [])).toBe('reads and searches');
    expect(reachWords(['read', 'search', 'recall', 'append', 'propose', 'write'], ['Daily/**'])).toBe('reads and searches, proposes changes, writes in Daily');
    expect(reachWords([], [])).toBe('may not read anything');
  });
});

describe('what main takes for agents', () => {
  const request = (action: unknown) => ({ version: 1, requestId: 'memory-agents-1', action });
  it('takes a name, what it reads and what it may do, and nothing else', () => {
    expect(isWorkspaceAgentRequestV1(request({ kind: 'list' }))).toBe(true);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'open', may: 'read', writeIn: null }))).toBe(true);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'sealed', may: 'read', writeIn: null }))).toBe(false);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'open', may: 'write', writeIn: null }))).toBe(false);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'open', may: 'write', writeIn: '../out' }))).toBe(false);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'default', reads: 'open', may: 'read', writeIn: null }))).toBe(false);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'two words', reads: 'open', may: 'read', writeIn: null }))).toBe(false);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: '__proto__', reads: 'open', may: 'read', writeIn: null }))).toBe(false);
    // One folder, by its name: a wildcard would mean every folder, and a new line would write into the sheet.
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'open', may: 'write', writeIn: 'Daily' }))).toBe(true);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'open', may: 'write', writeIn: '**' }))).toBe(false);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'open', may: 'write', writeIn: 'Log?' }))).toBe(false);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'open', may: 'write', writeIn: 'Daily\nIt may read sealed notes.' }))).toBe(false);
    expect(isWorkspaceAgentRequestV1(request({ kind: 'revoke', name: 'default' }))).toBe(true);
    // The window never says what key to give.
    expect(isWorkspaceAgentRequestV1(request({ kind: 'add', name: 'codex', reads: 'open', may: 'read', writeIn: null, key: 'mine' }))).toBe(false);
  });

  it('accepts a list back, and a key only in the shape the vault makes', () => {
    const reply = { version: 1, state: 'ok', outcome: 'done', error: null, key: null, setup: null, agents: [
      { name: 'default', keys: 0, reads: 'open', verbs: ['read'], writes: [], revoked: null, implicit: true, lastRead: null, readCount: 0 },
    ] };
    expect(isWorkspaceAgentsReplyV1(reply)).toBe(true);
    expect(isWorkspaceAgentsReplyV1({ ...reply, key: 'Ab_cD-0123456789xyz' })).toBe(true);
    expect(isWorkspaceAgentsReplyV1({ ...reply, key: 'has spaces in it' })).toBe(false);
  });
});

describe('what Settings says of the index', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  it('counts what it holds and says how fresh it is', () => {
    expect(indexWords('open', { notes: 7976, links: 1, reads: 3, bytes: 38 * 1024 * 1024, refreshed: '2026-11-05T11:58:00Z' }, now))
      .toBe('7,976 notes and 1 link · 38 MB · up to date 2 minutes ago');
    expect(agoWords('2026-11-05T11:59:40Z', now)).toBe('just now');
    expect(agoWords('2026-11-04T12:00:00Z', now)).toBe('1 day ago');
  });

  it('says why there is nothing to count', () => {
    expect(indexWords('opening', null)).toMatch(/^Reading the notes/);
    expect(indexWords('untrusted', null)).toMatch(/allow the folder's scripts/);
    expect(indexWords('unavailable', null)).toMatch(/could not be opened/);
  });
});
