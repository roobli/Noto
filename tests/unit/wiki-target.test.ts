import { describe, expect, it } from 'vitest';
import { normalisePath, relPathFromDir, wikiCandidates, wikiTargetFor, type WikiCandidate } from '../../src/renderer/wiki-target';

const entry = (relativePath: string): WikiCandidate => ({
  path: `/vault/${relativePath}`,
  relativePath,
  name: relativePath.split('/').at(-1)!,
});

// The shapes the author's vault actually holds.
const VAULT = [
  entry('E_works/acme/00_索引.md'),
  entry('E_works/acme/lab网络规划/00_索引.md'),
  entry('E_works/acme/lab网络规划/方案demo.md'),
  entry('E_works/acme/数据组/00_索引.md'),
  entry('A_topics/00_索引.md'),
  entry('00_索引.md'),
];

const from = 'E_works/acme/00_索引.md';
const found = (target: string, source: string | null = from) =>
  wikiCandidates(target, source, VAULT).map((candidate) => candidate.relativePath);

describe('a path a wiki link names', () => {
  it('is resolved against the folder the link was written in first', () => {
    expect(found('lab网络规划/00_索引')[0]).toBe('E_works/acme/lab网络规划/00_索引.md');
    expect(found('数据组/00_索引')[0]).toBe('E_works/acme/数据组/00_索引.md');
  });

  it('is resolved against the vault root when the folder holds nothing like it', () => {
    expect(found('A_topics/00_索引')[0]).toBe('A_topics/00_索引.md');
  });

  it('reads a written extension, and a heading after it, as neither', () => {
    expect(found('lab网络规划/方案demo.md')[0]).toBe('E_works/acme/lab网络规划/方案demo.md');
    expect(found('lab网络规划/方案demo#结论')[0]).toBe('E_works/acme/lab网络规划/方案demo.md');
  });

  it('walks up out of the folder when the link says to', () => {
    expect(wikiCandidates('../../00_索引', 'E_works/acme/00_索引.md', VAULT)[0].relativePath)
      .toBe('00_索引.md');
  });
});

describe('a bare name a wiki link gives', () => {
  it('means the nearest note with that name', () => {
    expect(found('00_索引')[0]).toBe('E_works/acme/00_索引.md');
    expect(found('00_索引', 'E_works/acme/lab网络规划/方案demo.md')[0])
      .toBe('E_works/acme/lab网络规划/00_索引.md');
    expect(found('00_索引', 'A_topics/anything.md')[0])
      .toBe('A_topics/00_索引.md');
  });

  it('still offers the others, so the caller can choose between them', () => {
    expect(found('00_索引')).toHaveLength(5);
  });

  it('is nothing when no note is called that', () => {
    expect(found('nowhere at all')).toEqual([]);
    expect(found('')).toEqual([]);
  });
});

describe('the path arithmetic', () => {
  it('resolves the dots and keeps the rest', () => {
    expect(normalisePath('a/./b/../c')).toBe('a/c');
    expect(normalisePath('/a//b/')).toBe('a/b');
    expect(normalisePath('../../x')).toBe('x');
  });
});

describe('wikiTargetFor', () => {
  it('writes a note-relative target the way apply-graph and MOCs do', () => {
    expect(wikiTargetFor(
      'A_topics/systems/00_系统总览.md',
      'Z_hubs/网络索引.md',
    )).toBe('../A_topics/systems/00_系统总览');

    expect(wikiTargetFor(
      'Z_hubs/模型部署.md',
      'Z_hubs/网络索引.md',
    )).toBe('模型部署');

    expect(wikiTargetFor(
      'P_public/首页.md',
      'P_public/daily/00_索引.md',
    )).toBe('../首页');
  });

  it('matches relPathFromDir then strips the extension', () => {
    expect(relPathFromDir(
      'A_topics/foo.md',
      'Z_hubs',
    )).toBe('../A_topics/foo.md');
    expect(wikiTargetFor('V_archive/note.md', 'V_archive/note.md')).toBe('note');
  });
});
