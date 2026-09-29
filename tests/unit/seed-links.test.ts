/**
 * Seeding the Links rail from in-note wiki targets when the graph skips a MOC.
 */
import { describe, expect, it } from 'vitest';
import {
  markdownForLinkSeed, seedOutboundLinks, wikiLinksInMarkdown,
} from '../../src/renderer/seed-links';
import type { WikiCandidate } from '../../src/renderer/wiki-target';

const entry = (relativePath: string): WikiCandidate => ({
  path: `/vault/${relativePath}`,
  relativePath,
  name: relativePath.split('/').at(-1)!,
});

const VAULT = [
  entry('Z_hubs/网络索引.md'),
  entry('A_topics/systems/00_系统总览.md'),
  entry('A_topics/systems/缓存调优.md'),
  entry('P_public/首页.md'),
  entry('V_archive/alpha.md'),
];

const MOC = [
  '# 网络索引',
  '',
  '<!-- note-assistant:index:start -->',
  '',
  '## 目录索引',
  '',
  '- [[../A_topics/systems/00_系统总览|系统总览]]',
  '- [[../A_topics/systems/缓存调优|缓存调优]]',
  '- [[../P_public/首页|首页]]',
  '',
  '<!-- note-assistant:index:end -->',
  '',
  'Prose mentions [[V_archive/alpha|alpha]] outside the index.',
  '',
].join('\n');

describe('wiki links written in a note', () => {
  it('prefers the index region when seeding a MOC hub', () => {
    const seedBody = markdownForLinkSeed(MOC);
    expect(seedBody).toContain('系统总览');
    expect(seedBody).not.toContain('V_archive/alpha');
    expect(wikiLinksInMarkdown(seedBody)).toHaveLength(3);
  });

  it('resolves note-relative targets against the vault index', () => {
    const links = seedOutboundLinks(MOC, 'Z_hubs/网络索引.md', VAULT);
    expect(links.map((link) => link.relativePath)).toEqual([
      'A_topics/systems/00_系统总览.md',
      'A_topics/systems/缓存调优.md',
      'P_public/首页.md',
    ]);
    expect(links[0].title).toBe('系统总览');
  });

  it('falls back to the whole note when there is no index region', () => {
    const note = 'See [[../P_public/首页|首页]] and [[缓存调优]].\n';
    const links = seedOutboundLinks(note, 'A_topics/systems/00_系统总览.md', VAULT);
    expect(links.map((link) => link.relativePath)).toEqual([
      'P_public/首页.md',
      'A_topics/systems/缓存调优.md',
    ]);
  });
});
