/**
 * The setup an agent needs to reach a folder's memory, as text to paste:
 * the MCP server is the vault's command line shipped with Noto, run by
 * Node, told the folder and the agent's key.
 */

import { sizeWords } from '../shared/size-words';

export interface MemorySetup {
  /** The vault's command line, unpacked beside Noto. */
  readonly script: string;
  /** The folder whose memory it serves. */
  readonly root: string;
}

/** The server's name in the agent's list: one per folder, so two folders do not collide. */
export function serverName(root: string): string {
  const base = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const slug = base.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return `noto-${slug || 'vault'}`;
}

/** A word for a POSIX shell, quoted only when it has to be. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The one line to run where Claude Code is: it adds the server for every project. */
export function claudeCodeSetup(setup: MemorySetup, key: string): string {
  return [
    'claude', 'mcp', 'add', serverName(setup.root), '--scope', 'user',
    '--env', `NOTO_VAULT_ROOT=${setup.root}`, '--env', `NOTO_VAULT_KEY=${key}`,
    '--', 'node', setup.script, 'mcp',
  ].map(shellWord).join(' ');
}

/** The block for Codex's `~/.codex/config.toml`. JSON strings are TOML basic strings. */
export function codexSetup(setup: MemorySetup, key: string): string {
  return [
    `[mcp_servers.${serverName(setup.root)}]`,
    'command = "node"',
    `args = [${JSON.stringify(setup.script)}, "mcp"]`,
    `env = { NOTO_VAULT_ROOT = ${JSON.stringify(setup.root)}, NOTO_VAULT_KEY = ${JSON.stringify(key)} }`,
    '',
  ].join('\n');
}

/** What an agent may do, in a few words, from the verbs and paths the policy gives it. */
export function reachWords(verbs: readonly string[], writes: readonly string[]): string {
  if (verbs.length === 0) return 'may not read anything';
  const parts = ['reads and searches'];
  if (verbs.includes('propose')) parts.push('proposes changes');
  if (verbs.includes('write') && writes.length > 0) parts.push(`writes in ${writes.map((pattern) => pattern.replace(/\/\*\*$|\/$/, '')).join(', ')}`);
  return parts.join(', ');
}


/** How long ago, roughly, as a person says it. */
export function agoWords(at: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds)) return 'at a time not known';
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** What the index holds, or why it holds nothing now, in one line. */
export function indexWords(
  state: 'outside' | 'no-memory' | 'untrusted' | 'opening' | 'open' | 'unavailable',
  index: { notes: number; links: number; reads: number; bytes: number; refreshed: string | null } | null,
  now = Date.now(),
): string {
  if (state === 'opening') return 'Reading the notes. A large folder takes a while the first time.';
  if (state === 'untrusted') return 'Waiting for you to allow the folder\'s scripts, in Note Info.';
  if (state === 'unavailable' || index === null) return 'The index could not be opened. Your notes are not affected.';
  const count = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
  const parts = [`${count(index.notes, 'note', 'notes')} and ${count(index.links, 'link', 'links')}`, sizeWords(index.bytes)];
  if (index.refreshed) parts.push(`up to date ${agoWords(index.refreshed, now)}`);
  return parts.join(' · ');
}
