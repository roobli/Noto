/**
 * Quick open's ranking.
 *
 * Pinned because the weightings are the author's own, carried over from the
 * `fuzzy-search` Typora plugin his hands are trained on: a change that quietly
 * reorders results is a change to muscle memory, and it should have to be
 * argued for in a diff rather than discovered while looking for a note.
 */

import { describe, expect, it } from 'vitest';
import {
  fuzzyScore, isPathQuery, matchPositions, NO_MATCH, rankCandidates, scoreCandidate,
} from '../../src/shared/search/v1/fuzzy';

const keys = (name: string, path: string) => ({
  nameKey: name.toLowerCase(), pathKey: path.toLowerCase(),
});
const plain = { pathQuery: false, frecencyBoost: 0 };

describe('fuzzy scoring', () => {
  it('refuses a query whose characters are not all present in order', () => {
    expect(fuzzyScore('release notes', 'zzz')).toBe(NO_MATCH);
    expect(fuzzyScore('release notes', 'seler')).toBe(NO_MATCH);
  });

  it('prefers a consecutive run over a scattered subsequence', () => {
    expect(fuzzyScore('release', 'rele')).toBeGreaterThan(fuzzyScore('remote label', 'rele'));
  });

  it('prefers a word boundary over a match inside a word', () => {
    expect(fuzzyScore('data_service', 'ds')).toBeGreaterThan(fuzzyScore('addendums', 'ds'));
  });

  it('rewards an exact prefix', () => {
    expect(fuzzyScore('index.md', 'index')).toBeGreaterThan(fuzzyScore('my-index.md', 'index'));
  });

  it('matches CJK without case folding getting in the way', () => {
    expect(fuzzyScore('发展规划', '发展')).toBeGreaterThan(NO_MATCH);
    expect(matchPositions('AAA_发展规划.md', '发展')).toEqual([4, 5]);
  });
});

describe('choosing between a name and a path', () => {
  it('lets the name win for a plain query', () => {
    const named = scoreCandidate(keys('index.md', 'deep/nested/index.md'), 'index', plain);
    const pathy = scoreCandidate(keys('other.md', 'index/other.md'), 'index', plain);
    expect(named).toBeGreaterThan(pathy);
  });

  it('lets the path win once the query names one', () => {
    const options = { pathQuery: true, frecencyBoost: 0 };
    const inFolder = scoreCandidate(keys('other.md', 'acme/data/other.md'), 'acme/data', options);
    expect(inFolder).toBeGreaterThan(NO_MATCH);
    expect(isPathQuery('acme/data')).toBe(true);
    expect(isPathQuery('acme')).toBe(false);
  });

  it('lets history lift a comparable match without overturning a better one', () => {
    const cold = scoreCandidate(keys('release.md', 'a/release.md'), 'release', plain);
    const warm = scoreCandidate(keys('release.md', 'b/release.md'), 'release',
      { pathQuery: false, frecencyBoost: 40 });
    expect(warm).toBeGreaterThan(cold);
    // A much weaker textual match is not rescued by history alone.
    const distant = scoreCandidate(keys('rambling essay.md', 'c/rambling essay.md'), 'release',
      { pathQuery: false, frecencyBoost: 40 });
    expect(distant).toBeLessThan(cold);
  });
});

describe('ranking a whole vault', () => {
  const vault = Array.from({ length: 500 }, (_, index) => keys(`note-${index}.md`, `dir${index % 7}/note-${index}.md`));

  it('returns at most the limit, best first', () => {
    const ranked = rankCandidates([...vault, keys('note-7.md', 'a/note-7.md')], 'note7', () => plain, 5);
    expect(ranked.length).toBeLessThanOrEqual(5);
    expect(ranked[0].nameKey).toBe('note-7.md');
  });

  it('drops everything that does not match', () => {
    expect(rankCandidates(vault, 'zzzzz', () => plain, 10)).toEqual([]);
  });

  it('is stable, so a list does not reshuffle under the fingers', () => {
    const once = rankCandidates(vault, 'note1', () => plain, 8).map((entry) => entry.pathKey);
    const twice = rankCandidates(vault, 'note1', () => plain, 8).map((entry) => entry.pathKey);
    expect(once).toEqual(twice);
  });

  it('returns nothing for a limit of zero rather than everything', () => {
    expect(rankCandidates(vault, 'note', () => plain, 0)).toEqual([]);
  });
});

describe('a query of several words', () => {
  // Daily-use audit finding 11: `docker es` found nothing, because the space
  // had to be matched as a character of the name.
  it('wants every word, each in the name or the path', () => {
    const both = scoreCandidate(keys('deploy_es.md', 'Docker/deploy_es.md'), 'docker es', plain);
    expect(both).toBeGreaterThan(NO_MATCH);
    expect(scoreCandidate(keys('deploy_es.md', 'Docker/deploy_es.md'), 'docker  es ', plain)).toBe(both);
    expect(scoreCandidate(keys('deploy_es.md', 'Kube/deploy_es.md'), 'docker es', plain)).toBe(NO_MATCH);
  });

  it('matches the words in any order', () => {
    const forward = scoreCandidate(keys('es_docker.md', 'a/es_docker.md'), 'es docker', plain);
    const backward = scoreCandidate(keys('es_docker.md', 'a/es_docker.md'), 'docker es', plain);
    expect(forward).toBeGreaterThan(NO_MATCH);
    expect(backward).toBeGreaterThan(NO_MATCH);
  });

  it('ranks a note that carries both words above one that carries them scattered', () => {
    const vault = [
      keys('es_notes.md', 'misc/es_notes.md'),
      keys('deploy_es.md', 'Docker/deploy_es.md'),
      keys('docker_es.md', 'ops/docker_es.md'),
    ];
    const ranked = rankCandidates(vault, 'docker es', () => plain, 10);
    expect(ranked.map((candidate) => candidate.nameKey)).toEqual(['docker_es.md', 'deploy_es.md']);
  });

  it('marks each word in a name that holds it, and none when the name holds none', () => {
    expect(matchPositions('docker_es.md', 'es docker')).toEqual([0, 1, 2, 3, 4, 5, 7, 8]);
    expect(matchPositions('deploy_es.md', 'es')).toEqual([7, 8]);
    expect(matchPositions('deploy.md', 'docker zz')).toBeNull();
    expect(matchPositions('Docker 部署', 'docker 部署')).toEqual([0, 1, 2, 3, 4, 5, 7, 8]);
  });
});
