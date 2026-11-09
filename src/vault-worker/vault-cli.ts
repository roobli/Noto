/**
 * The vault's command line, shipped beside Noto so an agent's MCP server can
 * be started from the setup Noto copies, with no separate install: it is run
 * by the Node already on the machine (22.13 or later, for node:sqlite), as
 * `node <this file> mcp`. Noto itself does not run as Node: its fuses turn
 * that off.
 */

import { run } from '@roobli/vault/cli';

// node:sqlite says it is experimental on every start; stderr is kept for what means something.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  const first = rest[0] as string | { type?: string } | undefined;
  const type = typeof first === 'string' ? first : first?.type;
  if (type === 'ExperimentalWarning' && /SQLite/.test(text)) return;
  (emit as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// It sets the exit code itself.
void run(process.argv.slice(2));
