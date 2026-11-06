/**
 * The setup an agent needs to reach a folder's memory, as text to paste:
 * the MCP server is the vault's command line shipped with Noto, run by
 * Node, told the folder and the agent's key.
 */

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
