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
  return readFileSync(path.join(dir, host, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, string | number>);
};

describe('recording which notes were opened', () => {
  it('writes one line per open in a vault that keeps memory, with where it was reached from', async () => {
    mkdirSync(path.join(root, '.noto'));
    const visits = new VaultVisits();
    visits.opened(root, path.join(root, 'A', 'one.md'));
    // The same note again at once is the open activating its own tab.
    visits.opened(root, path.join(root, 'A', 'one.md'));
    visits.opened(root, path.join(root, 'B', 'two.md'), path.join(root, 'A', 'one.md'));
    const recorded = lines();
    expect(recorded.map((line) => [line.verb, line.actor, line.path, line.from])).toEqual([
      ['open', 'owner', 'A/one.md', undefined],
      ['open', 'owner', 'B/two.md', 'A/one.md'],
    ]);
    expect(recorded[0]!.session).toBe(recorded[1]!.session);
    expect(Number.isNaN(Date.parse(String(recorded[0]!.time)))).toBe(false);
  });

  it('leaves a folder without .noto/ as it is, and ignores what is not a note inside it', async () => {
    const visits = new VaultVisits();
    visits.opened(root, path.join(root, 'one.md'));
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
    mkdirSync(path.join(root, '.noto'));
    const fresh = new VaultVisits();
    fresh.opened(root, path.join(root, 'code.ts'));
    fresh.opened(root, path.join(os.tmpdir(), 'elsewhere.md'));
    fresh.opened(null, path.join(root, 'one.md'));
    expect(existsSync(path.join(root, '.noto', 'events'))).toBe(false);
  });
});

describe('a note opened again and again', () => {
  it('is written once at once, and the rest of the run counted on one line when it ends', () => {
    mkdirSync(path.join(root, '.noto'));
    let now = Date.parse('2026-11-06T07:09:34.000Z');
    const visits = new VaultVisits(undefined, undefined, () => now);
    for (const step of [0, 1_500, 3_000, 1_200, 1_000]) {
      now += step;
      visits.opened(root, path.join(root, 'Untitled.md'));
    }
    expect(lines()).toHaveLength(1);
    now += 2_000;
    visits.opened(root, path.join(root, 'two.md'));
    visits.flush();
    expect(lines().map((line) => [line.path, line.repeat, line.time, line.until])).toEqual([
      ['Untitled.md', undefined, '2026-11-06T07:09:34.000Z', undefined],
      ['Untitled.md', 4, '2026-11-06T07:09:35.500Z', '2026-11-06T07:09:40.700Z'],
      ['two.md', undefined, '2026-11-06T07:09:42.700Z', undefined],
    ]);
  });
});

describe('a folder that begins or stops keeping memory', () => {
  it('is recorded from the first open after it begins, and its .noto is never made again after it is deleted', async () => {
    const visits = new VaultVisits();
    visits.opened(root, path.join(root, 'one.md'));
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
    mkdirSync(path.join(root, '.noto'));
    visits.opened(root, path.join(root, 'two.md'));
    expect(lines().map((line) => line.path)).toEqual(['two.md']);
    rmSync(path.join(root, '.noto'), { recursive: true });
    visits.opened(root, path.join(root, 'three.md'));
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
  });

  it('takes a note whose name begins with two dots as inside the folder', async () => {
    mkdirSync(path.join(root, '.noto'));
    new VaultVisits().opened(root, path.join(root, '..notes.md'));
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
