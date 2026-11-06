/** One note's memory, whole and valid, for the tests that need an answer to hand. */

import type { NoteMemoryV1 } from '../../src/shared/workspace/v1/contracts';

export const MEMORY: NoteMemoryV1 = {
  path: 'a.md', title: 'A', id: null,
  kind: { value: 'note', from: 'default' }, known: { value: null, from: 'default' }, sensitivity: { value: 'open', from: 'folder' },
  status: null, tags: [], aliases: [],
  heat: { heat: 0.5, reads: 3, writes: 1, lastRead: '2026-11-05T10:00:00.000Z', lastWrite: null },
  supersededBy: null,
  linksHere: [{ path: 'b.md', title: 'B', relation: null, heat: 0.2, reads: 1 }], linksHereCount: 1,
  namedHere: [], namedHereCount: 0, together: [], togetherCount: 0, aboutSame: [],
  outgoing: { count: 0, broken: [], brokenCount: 0 },
  reads: [{ day: '2026-11-05', count: 3 }], readers: [{ actor: 'owner', count: 3, last: '2026-11-05T10:00:00.000Z' }],
  leadsHere: [], writes: { commits: 1, appends: 0, agents: [] }, agents: [{ name: 'claude-code', canSee: false, why: 'the note is private' }],
};
