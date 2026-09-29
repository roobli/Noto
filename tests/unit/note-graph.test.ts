import { describe, expect, it } from 'vitest';
import {
  deriveLinksFor, hubEdgeAliases, linksFor, linksForNote, parseGraph,
} from '../../src/main/workspace/note-graph';

const GRAPH = JSON.stringify({
  schemaVersion: 2,
  generatedAt: '2026-08-27T13:22:00Z',
  root: '/vault',
  notes: [
    {
      relPath: 'a/one.md', title: 'One',
      explicitLinks: ['a/two.md', 'missing/three.md'],
      backlinks: ['b/four.md'],
      candidates: [
        { relPath: 'a/two.md', title: 'Two', score: 90 },
        { relPath: 'c/five.md', title: 'Five', score: 10 },
        { relPath: 'c/six.md', title: 'Six', score: 40 },
        { relPath: 'a/one.md', title: 'One', score: 99 },
      ],
    },
    { relPath: 'a/two.md', title: 'Two (its own title)' },
    { relPath: 'b/four.md', title: 'Four' },
    { relPath: 'c/six.md', title: 'Six' },
  ],
});

/** Synthetic vault where a MOC hub has no row, but other notes point at it. */
const HUB_GRAPH = JSON.stringify({
  schemaVersion: 2,
  generatedAt: '2026-09-10T00:00:00Z',
  root: '/vault',
  notes: [
    {
      relPath: 'A000/vpn/mihomo.md', title: 'mihomo',
      explicitLinks: ['Z_hubs/网络索引.md', 'A_topics/net/other.md'],
      candidates: [
        { relPath: 'Z_hubs/网络索引.md', title: '网络索引', score: 50 },
        { relPath: 'A_topics/net/other.md', title: 'other', score: 10 },
      ],
    },
    {
      relPath: 'A000/linux/tmux.md', title: 'tmux index',
      explicitLinks: ['Z_hubs/网络索引'],
      related: [{ relPath: 'A000/vpn/mihomo.md', title: 'mihomo', score: 5 }],
    },
    {
      relPath: 'A_topics/net/other.md', title: 'other',
      explicitLinks: [],
      candidates: [
        { relPath: 'Z_hubs/网络索引.md', title: '网络索引', score: 80 },
        { relPath: 'A000/linux/tmux.md', title: 'tmux', score: 20 },
      ],
    },
    {
      relPath: 'P_public/首页.md', title: 'Public home',
      explicitLinks: ['P_public/news.md'],
    },
  ],
});

describe("the vault's graph", () => {
  it('reads the file and refuses what is not a graph', () => {
    expect(parseGraph(GRAPH)!.notes.size).toBe(4);
    expect(parseGraph(GRAPH)!.generatedAt).toBe('2026-08-27T13:22:00Z');
    expect(parseGraph('not json')).toBeNull();
    expect(parseGraph('{"notes": "no"}')).toBeNull();
  });

  it('gives a note its links, its backlinks and its related notes, best first', () => {
    const links = linksFor(parseGraph(GRAPH)!, 'a/one.md')!;
    // A linked note is named by its own title; one the graph has not met by its file name.
    expect(links.links).toEqual([
      { relativePath: 'a/two.md', title: 'Two (its own title)' },
      { relativePath: 'missing/three.md', title: 'three' },
    ]);
    expect(links.backlinks).toEqual([{ relativePath: 'b/four.md', title: 'Four' }]);
    // Related leaves out what is already linked either way, and the note itself.
    expect(links.related.map((item) => item.title)).toEqual(['Six', 'Five']);
  });

  it('says when the graph has not met the note', () => {
    expect(linksFor(parseGraph(GRAPH)!, 'nowhere.md')).toBeNull();
  });
});

describe('MOC hubs absent from graph.notes', () => {
  const graph = () => parseGraph(HUB_GRAPH)!;
  const hub = 'Z_hubs/网络索引.md';

  it('builds path aliases without treating every same-basename path as the hub', () => {
    const aliases = hubEdgeAliases(hub, '网络索引');
    expect(aliases.paths.has(hub)).toBe(true);
    expect(aliases.paths.has('Z_hubs/网络索引')).toBe(true);
    expect(aliases.names.has('网络索引')).toBe(true);
    // A different folder's 首页 must not be an exact path alias of this hub.
    expect(aliases.paths.has('P_public/首页.md')).toBe(false);
  });

  it('derives Linked from by scanning other notes’ explicitLinks to the hub path', () => {
    const derived = deriveLinksFor(graph(), hub, '网络索引');
    expect(derived.links).toEqual([]);
    expect(derived.backlinks.map((item) => item.relativePath)).toEqual([
      'A000/linux/tmux.md',
      'A000/vpn/mihomo.md',
    ]);
    expect(derived.backlinks.map((item) => item.title)).toEqual(['tmux index', 'mihomo']);
  });

  it('derives Related from inverse related/candidate edges, omitting backlinks', () => {
    const derived = deriveLinksFor(graph(), hub);
    // mihomo already backlinks; other.md only scores the hub as related.
    expect(derived.related.map((item) => item.relativePath)).toEqual(['A_topics/net/other.md']);
    expect(derived.related[0].title).toBe('other');
  });

  it('does not invent neighbours when no edge points at the hub', () => {
    const derived = deriveLinksFor(graph(), 'Z_hubs/missing-hub.md', 'missing-hub');
    expect(derived).toEqual({ backlinks: [], links: [], related: [] });
  });

  it('does not treat a same-basename note in another folder as a backlink target', () => {
    // P_public/首页.md links to news — opening a fictional Z_hubs 首页 must stay empty.
    const derived = deriveLinksFor(graph(), 'Z_hubs/首页.md', '首页');
    expect(derived.backlinks).toEqual([]);
    expect(derived.related).toEqual([]);
  });

  it('linksForNote keeps known rows unchanged and falls back for hubs', () => {
    const known = linksForNote(parseGraph(GRAPH)!, 'a/one.md');
    expect(known.known).toBe(true);
    expect(known.links.links).toHaveLength(2);

    const hubResult = linksForNote(graph(), hub, '网络索引');
    expect(hubResult.known).toBe(false);
    expect(hubResult.links.backlinks).toHaveLength(2);
    expect(hubResult.links.links).toEqual([]);
    expect(hubResult.links.related).toHaveLength(1);
  });
});
