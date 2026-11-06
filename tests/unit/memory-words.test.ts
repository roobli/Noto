/**
 * The words the memory tabs use: when something happened, and how warm a
 * note is, said as what the heat is made of rather than as its number.
 */

import { describe, expect, it } from 'vitest';
import { ago, agentName, heatWords } from '../../src/renderer/plugins/bundled/memory/model';
import { MEMORY } from './memory-fixture';

const NOW = new Date(2026, 10, 5, 15, 0).getTime();
const at = (year: number, month: number, day: number, hour = 9) => new Date(year, month - 1, day, hour).toISOString();

describe('when', () => {
  it('says today, yesterday, a few days ago, then the date, with the year only when it is another', () => {
    expect(ago(at(2026, 11, 5, 1), NOW)).toBe('today');
    expect(ago(at(2026, 11, 4, 23), NOW)).toBe('yesterday');
    expect(ago(at(2026, 11, 1), NOW)).toBe('4 days ago');
    expect(ago(at(2026, 10, 12), NOW)).toBe('on Oct 12');
    expect(ago(at(2025, 10, 12), NOW)).toBe('on Oct 12, 2025');
  });
});

describe('how warm a note is', () => {
  it('names the reads and the writes and when, never the bare score', () => {
    const words = heatWords({ ...MEMORY, heat: { heat: 9.08, reads: 6, writes: 2, lastRead: at(2026, 11, 5), lastWrite: at(2026, 11, 3) } }, NOW);
    expect(words).toBe('Read 6 times, last today; written twice, last 2 days ago.');
    expect(words).not.toContain('9.08');
    expect(heatWords({ ...MEMORY, heat: { heat: 0.4, reads: 0, writes: 1, lastRead: null, lastWrite: at(2026, 11, 4) } }, NOW))
      .toBe('Written once, last yesterday.');
    expect(heatWords({ ...MEMORY, heat: { heat: 0, reads: 0, writes: 0, lastRead: null, lastWrite: null } }, NOW))
      .toBe('Not read or written since the folder began keeping memory.');
  });

  it('calls the policy for an agent with no key what it is', () => {
    expect(agentName('default')).toBe('Without a key');
    expect(agentName('claude-code')).toBe('claude-code');
  });
});
