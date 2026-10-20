/**
 * The git gutter's block diff and where its answers land in the editor.
 *
 * `diffBlocks` is pure and pinned case by case. `blocksOf` and the gutter
 * plugin are then driven together: the note at HEAD and the note now go
 * through the same `@roobli/md` split the editor's top-level nodes come from,
 * the result is keyed by block id as main sends it, and each decoration must
 * sit on the node that is that block, also after typing and after blocks come
 * and go.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { createOriginPlugin } from '../../src/renderer/editor/noto/origin-plugin';
import { gitDeletedBefore, gitEntryAt, gitGutterKey, gitGutterPlugin, setGitBlocks } from '../../src/renderer/editor/noto/git-gutter';
import type { NotoBlockOrigin } from '../../src/shared/markdown/v3/contracts';
import { diffBlocks } from '../../src/shared/git/block-diff';
import { blocksOf, committedText, gitBlockDiff, GUTTER_MAX_BYTES, showArguments } from '../../src/main/workspace/git-blocks';
import { systemGit } from '../../src/main/workspace/git-marks';
import { NOTO_WORKSPACE_VERSION, type WorkspaceGitBlocksV1 } from '../../src/shared/workspace/v1/contracts';

describe('diffBlocks', () => {
  it('finds nothing in an unchanged note', () => {
    expect(diffBlocks(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({ changed: [], deleted: [] });
  });

  it('marks a block edited in place as modified with its committed text', () => {
    expect(diffBlocks(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual({
      changed: [{ ordinal: 1, change: 'modified', head: 'b' }],
      deleted: [],
    });
  });

  it('marks an inserted block as added and keeps the blocks after it unchanged', () => {
    expect(diffBlocks(['a', 'b', 'c'], ['a', 'x', 'b', 'c'])).toEqual({
      changed: [{ ordinal: 1, change: 'added', head: null }],
      deleted: [],
    });
  });

  it('places a deleted run before the block that followed it, joined by a blank line', () => {
    expect(diffBlocks(['a', 'b', 'c', 'd'], ['a', 'd'])).toEqual({
      changed: [],
      deleted: [{ before: 1, head: 'b\n\nc' }],
    });
  });

  it('places blocks deleted from the end at the block count', () => {
    expect(diffBlocks(['a', 'b', 'c'], ['a'])).toEqual({ changed: [], deleted: [{ before: 1, head: 'b\n\nc' }] });
  });

  it('places blocks deleted from the start at zero', () => {
    expect(diffBlocks(['a', 'b', 'c'], ['c'])).toEqual({ changed: [], deleted: [{ before: 0, head: 'a\n\nb' }] });
  });

  it('pairs an unmatched run positionally: modified first, then added', () => {
    expect(diffBlocks(['a', 'b', 'z'], ['a', 'B', 'C', 'z'])).toEqual({
      changed: [
        { ordinal: 1, change: 'modified', head: 'b' },
        { ordinal: 2, change: 'added', head: null },
      ],
      deleted: [],
    });
  });

  it('pairs an unmatched run positionally: modified, then the rest deleted', () => {
    expect(diffBlocks(['a', 'b', 'c', 'z'], ['a', 'B', 'z'])).toEqual({
      changed: [{ ordinal: 1, change: 'modified', head: 'b' }],
      deleted: [{ before: 2, head: 'c' }],
    });
  });

  it('treats every block of a note with no committed blocks as added', () => {
    expect(diffBlocks([], ['a', 'b']).changed.map((entry) => entry.change)).toEqual(['added', 'added']);
  });

  it('aligns moved-past blocks rather than calling everything changed', () => {
    const head = ['h', 'p1', 'p2', 'p3', 'p4'];
    const now = ['h', 'p2', 'p3', 'new', 'p4'];
    const result = diffBlocks(head, now);
    expect(result.changed).toEqual([{ ordinal: 3, change: 'added', head: null }]);
    expect(result.deleted).toEqual([{ before: 1, head: 'p1' }]);
  });

  it('stays bounded on a huge differing middle: no alignment, still an answer', () => {
    const head = Array.from({ length: 3000 }, (_, index) => `h${index}`);
    const now = Array.from({ length: 3000 }, (_, index) => `n${index}`);
    const started = performance.now();
    const result = diffBlocks(head, now, 1000);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.changed).toHaveLength(3000);
    expect(result.changed.every((entry) => entry.change === 'modified')).toBe(true);
  });

  it('diffs a 5000-block note with one edit quickly (prefix and suffix are trimmed)', () => {
    const head = Array.from({ length: 5000 }, (_, index) => `block ${index}`);
    const now = head.slice();
    now[2500] = 'edited';
    const started = performance.now();
    const result = diffBlocks(head, now);
    expect(performance.now() - started).toBeLessThan(100);
    expect(result.changed).toEqual([{ ordinal: 2500, change: 'modified', head: 'block 2500' }]);
  });
});

describe('blocksOf', () => {
  it('splits a note as @roobli/md does and ignores BOM and line endings', () => {
    const lf = '# Title\n\nOne.\n\n- a\n- b\n';
    expect(blocksOf(lf)).toHaveLength(3);
    expect(blocksOf('\uFEFF' + lf.replace(/\n/g, '\r\n'))).toEqual(blocksOf(lf));
  });

  it('diffs a CRLF commit against an LF note as unchanged', () => {
    const lf = '# Title\n\nOne.\n\nTwo.\n';
    expect(diffBlocks(blocksOf(lf.replace(/\n/g, '\r\n')), blocksOf(lf))).toEqual({ changed: [], deleted: [] });
  });

  it('reads the committed blob with read-only plumbing', () => {
    const args = showArguments('a note.md');
    expect(args.slice(0, 3)).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false']);
    expect(args.at(-1)).toBe('HEAD:./a note.md');
    expect(args).not.toContain('show');
  });
});

// The editor side: block ids from main landing on nodes.

function para(text: string) {
  return notoSchema.nodes.paragraph.create(null, notoSchema.text(text));
}

function originsFor(count: number): NotoBlockOrigin[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    blockId: `noto-block-v3:${ordinal}:test` as NotoBlockOrigin['blockId'],
    ordinal,
    kind: 'paragraph',
    semanticKey: '',
  }));
}

function event(blocks: WorkspaceGitBlocksV1['blocks'], deleted: WorkspaceGitBlocksV1['deleted'] = []): WorkspaceGitBlocksV1 {
  return { version: NOTO_WORKSPACE_VERSION, documentId: 'doc', blocks, deleted };
}

function stateWith(texts: string[], gutter: WorkspaceGitBlocksV1) {
  const doc = notoSchema.nodes.doc.create(null, texts.map(para));
  const state = EditorState.create({ doc, plugins: [createOriginPlugin(originsFor(texts.length)), gitGutterPlugin()] });
  return state.apply(setGitBlocks(state.tr, gutter));
}

/** The top-level index each node decoration sits on, with its class. */
function decorated(state: EditorState): Array<[number, string]> {
  const set = gitGutterKey.getState(state)!.decorations;
  const out: Array<[number, string]> = [];
  let pos = 0;
  for (let index = 0; index < state.doc.childCount; index += 1) {
    const node = state.doc.child(index);
    for (const decoration of set.find(pos, pos + node.nodeSize)) {
      const spec = (decoration as unknown as { type: { attrs?: { class?: string } } }).type.attrs;
      if (decoration.from === pos && decoration.to === pos + node.nodeSize && spec?.class) out.push([index, spec.class]);
    }
    pos += node.nodeSize;
  }
  return out;
}

describe('git gutter mapping', () => {
  const id = (ordinal: number) => `noto-block-v3:${ordinal}:test`;

  it('lands each entry on the node whose origin is that block', () => {
    const state = stateWith(['one', 'two', 'three'], event([
      { blockId: id(1), change: 'modified', head: 'committed two' },
      { blockId: id(2), change: 'added', head: null },
    ]));
    expect(decorated(state)).toEqual([[1, 'noto-git-block noto-git-modified'], [2, 'noto-git-block noto-git-added']]);
    expect(gitEntryAt(state, 1)).toEqual({ change: 'modified', head: 'committed two' });
    expect(gitEntryAt(state, 0)).toBeNull();
  });

  it('maps through typing inside a block without rebuilding', () => {
    const state = stateWith(['one', 'two', 'three'], event([{ blockId: id(2), change: 'modified', head: 'x' }]));
    const before = gitGutterKey.getState(state)!;
    const next = state.apply(state.tr.insertText('typed ', 2));
    const after = gitGutterKey.getState(next)!;
    expect(after.origins).toBe(before.origins);
    expect(decorated(next)).toEqual([[2, 'noto-git-block noto-git-modified']]);
  });

  it('follows its block when a block is inserted above it', () => {
    const state = stateWith(['one', 'two', 'three'], event([{ blockId: id(2), change: 'modified', head: 'x' }]));
    const next = state.apply(state.tr.insert(0, para('new first')));
    expect(next.doc.childCount).toBe(4);
    expect(decorated(next)).toEqual([[3, 'noto-git-block noto-git-modified']]);
  });

  it('keeps deleted runs on the block that follows them, and at the end', () => {
    const state = stateWith(['one', 'two'], event([], [
      { beforeBlockId: id(1), head: 'gone' },
      { beforeBlockId: null, head: 'tail gone' },
    ]));
    expect(gitDeletedBefore(state, 1)).toBe('gone');
    expect(gitDeletedBefore(state, 0)).toBeNull();
    expect(gitDeletedBefore(state, 2)).toBe('tail gone');
    const widgets = gitGutterKey.getState(state)!.decorations.find().filter((decoration) => decoration.from === decoration.to);
    expect(widgets.map((decoration) => decoration.from)).toEqual([5, state.doc.content.size]);
  });

  it('clears on a null event and stays out of undo history', () => {
    const state = stateWith(['one'], event([{ blockId: id(0), change: 'added', head: null }]));
    const tr = setGitBlocks(state.tr, null);
    expect(tr.getMeta('addToHistory')).toBe(false);
    expect(decorated(state.apply(tr))).toEqual([]);
  });

  it('ignores ids it has no node for', () => {
    const state = stateWith(['one'], event([{ blockId: 'noto-block-v3:9:other', change: 'modified', head: 'x' }]));
    expect(decorated(state)).toEqual([]);
  });
});

// Against a real repository with the system git, as the tree marks are.

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!hasGit)('committed text from a real repository', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'noto-git-blocks-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(root, 'sub folder'));
  writeFileSync(path.join(root, 'sub folder', 'a note.md'), '# Title\n\nOne.\n\nTwo.\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  writeFileSync(path.join(root, 'untracked.md'), 'New.\n');
  writeFileSync(path.join(root, 'staged.md'), 'Staged.\n');
  git('add', 'staged.md');
  const run = systemGit('git');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads a note in a subfolder with a space in its path', async () => {
    expect(await committedText(run, path.join(root, 'sub folder', 'a note.md'))).toBe('# Title\n\nOne.\n\nTwo.\n');
  });

  it('diffs the saved note against HEAD', async () => {
    const now = blocksOf('# Title\n\nOne, edited.\n\nTwo.\n\nThree.\n');
    const result = await gitBlockDiff(run, path.join(root, 'sub folder', 'a note.md'), now, 40);
    expect(result).toEqual({
      changed: [{ ordinal: 1, change: 'modified', head: 'One.' }, { ordinal: 3, change: 'added', head: null }],
      deleted: [],
    });
  });

  it('has nothing for an untracked or only-staged note, or outside a repository', async () => {
    expect(await committedText(run, path.join(root, 'untracked.md'))).toBeNull();
    expect(await committedText(run, path.join(root, 'staged.md'))).toBeNull();
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'noto-no-repo-')));
    writeFileSync(path.join(outside, 'n.md'), 'x\n');
    expect(await committedText(run, path.join(outside, 'n.md'))).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it('skips a note over the size threshold without asking git', async () => {
    let asked = false;
    const result = await gitBlockDiff(async () => { asked = true; return ''; }, path.join(root, 'sub folder', 'a note.md'), [], GUTTER_MAX_BYTES + 1);
    expect(result).toBeNull();
    expect(asked).toBe(false);
  });
});
