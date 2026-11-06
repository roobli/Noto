import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultVisits } from '../../src/main/workspace/vault-visits';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-visits-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lines = () => {
  const dir = path.join(root, '.noto', 'events');
  const host = readdirSync(dir)[0]!;
  const file = readdirSync(path.join(dir, host))[0]!;
  return readFileSync(path.join(dir, host, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
};

describe('recording which notes were opened', () => {
  it('writes one line per open in a vault that keeps memory, with where it was reached from', async () => {
    mkdirSync(path.join(root, '.noto'));
    const visits = new VaultVisits();
    await visits.opened(root, path.join(root, 'A', 'one.md'));
    // The same note again at once is the open activating its own tab.
    await visits.opened(root, path.join(root, 'A', 'one.md'));
    await visits.opened(root, path.join(root, 'B', 'two.md'), path.join(root, 'A', 'one.md'));
    const recorded = lines();
    expect(recorded.map((line) => [line.verb, line.actor, line.path, line.from])).toEqual([
      ['open', 'owner', 'A/one.md', undefined],
      ['open', 'owner', 'B/two.md', 'A/one.md'],
    ]);
    expect(recorded[0]!.session).toBe(recorded[1]!.session);
    expect(Number.isNaN(Date.parse(recorded[0]!.time!))).toBe(false);
  });

  it('leaves a folder without .noto/ as it is, and ignores what is not a note inside it', async () => {
    const visits = new VaultVisits();
    await visits.opened(root, path.join(root, 'one.md'));
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
    mkdirSync(path.join(root, '.noto'));
    const fresh = new VaultVisits();
    await fresh.opened(root, path.join(root, 'code.ts'));
    await fresh.opened(root, path.join(os.tmpdir(), 'elsewhere.md'));
    await fresh.opened(null, path.join(root, 'one.md'));
    expect(existsSync(path.join(root, '.noto', 'events'))).toBe(false);
  });
});

describe('a folder that begins or stops keeping memory', () => {
  it('is recorded from the first open after it begins, and its .noto is never made again after it is deleted', async () => {
    const visits = new VaultVisits();
    await visits.opened(root, path.join(root, 'one.md'));
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
    mkdirSync(path.join(root, '.noto'));
    await visits.opened(root, path.join(root, 'two.md'));
    expect(lines().map((line) => line.path)).toEqual(['two.md']);
    rmSync(path.join(root, '.noto'), { recursive: true });
    await visits.opened(root, path.join(root, 'three.md'));
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
  });

  it('takes a note whose name begins with two dots as inside the folder', async () => {
    mkdirSync(path.join(root, '.noto'));
    await new VaultVisits().opened(root, path.join(root, '..notes.md'));
    expect(lines().map((line) => line.path)).toEqual(['..notes.md']);
  });
});

describe('the open request', () => {
  it('may say which note it was reached from, and nothing else new', async () => {
    const { isWorkspaceOpenPathRequestV1 } = await import('../../src/shared/workspace/v1/validate');
    const base = { version: 1, requestId: 'open-path-1', path: '/v/a.md' };
    expect(isWorkspaceOpenPathRequestV1(base)).toBe(true);
    expect(isWorkspaceOpenPathRequestV1({ ...base, from: '/v/b.md' })).toBe(true);
    expect(isWorkspaceOpenPathRequestV1({ ...base, from: '' })).toBe(false);
    expect(isWorkspaceOpenPathRequestV1({ ...base, from: 3 })).toBe(false);
    expect(isWorkspaceOpenPathRequestV1({ ...base, other: 'x' })).toBe(false);
  });
});
