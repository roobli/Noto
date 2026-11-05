/**
 * Changes: the notes that differ from the last commit, and nothing else.
 *
 * The file tree marks changed notes where they sit, which answers "is this
 * note changed". This answers "what did I change": every changed note in one
 * short tree, ready to open, the view `git status` gives in a terminal. A
 * deleted note is listed, struck through, since it has no file to open.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { RailPageHost } from '../../slots';
import { FileGlyph, FolderGlyph, GitMark, sizeTreeGuides } from '../../ui-kit';
import { changeCounts, changeTree, type ChangeNode } from './tree';

const WORDS = { modified: 'Changed', new: 'New', deleted: 'Deleted' } as const;

function Level({ nodes, depth, root, active, folded, onFold, onOpen, onMenu }: {
  nodes: readonly ChangeNode[];
  depth: number;
  root: string;
  active: string | null;
  folded: ReadonlySet<string>;
  onFold: (key: string) => void;
  onOpen: (path: string) => void;
  onMenu: (path: string, kind: 'file' | 'directory') => void;
}) {
  return (
    <div className={depth === 0 ? 'tree-level is-root' : 'tree-level'} style={{ '--tree-depth': depth } as CSSProperties}>
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const open = !folded.has(node.key);
          return (
            <div className="tree-node" key={node.key}>
              <button type="button" className="tree-row tree-directory" data-testid="changes-folder" data-depth={depth}
                title={node.name} aria-expanded={open} onClick={() => onFold(node.key)}
                // A chain of folders is one row, and its menu is the last folder's: where its notes are.
                onContextMenu={(event) => { event.preventDefault(); onMenu(`${root}/${node.key}`, 'directory'); }}>
                <span className="tree-leading">
                  <span className={open ? 'tree-twisty tree-twisty-open' : 'tree-twisty'} aria-hidden="true" />
                  <FolderGlyph />
                </span>
                <span className="tree-name">{node.name}</span>
              </button>
              {open && <Level nodes={node.children} depth={depth + 1} root={root} active={active} folded={folded} onFold={onFold} onOpen={onOpen} onMenu={onMenu} />}
            </div>
          );
        }
        const isActive = node.path === active;
        const deleted = node.change === 'deleted';
        return (
          <div className={isActive ? 'tree-node tree-node-active' : 'tree-node'} key={node.path}>
            <button type="button"
              className={`tree-row tree-file${isActive ? ' tree-file-active' : ''}${deleted ? ' changes-deleted' : ''}`}
              data-testid="changes-file" data-path={node.path} data-change={node.change}
              title={`${node.name}, ${WORDS[node.change]}`}
              aria-current={isActive ? 'true' : undefined}
              aria-disabled={deleted ? 'true' : undefined}
              onClick={() => { if (!deleted) onOpen(node.path); }}
              // The same menu as the row in the file tree. A deleted note has no file for it to act on.
              onContextMenu={(event) => { event.preventDefault(); if (!deleted) onMenu(node.path, 'file'); }}>
              <span className="tree-leading">
                <span className="tree-twisty tree-twisty-blank" aria-hidden="true" />
                <FileGlyph />
              </span>
              <span className="tree-name">{node.name}</span>
              {deleted ? <span className="changes-deleted-mark" aria-hidden="true" /> : <GitMark kind={node.change} />}
              {deleted && <span className="tree-git-words">, {WORDS.deleted}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ChangesPage({ host }: { host: RailPageHost }) {
  const where = useSyncExternalStore(host.subscribe, () => `${host.folder() ?? ''}\0${host.activeNote() ?? ''}`);
  const [root, active] = where.split('\0') as [string, string];
  const git = host.git;
  const marks = useSyncExternalStore(git ? git.subscribe : () => () => {}, () => (git ? git.current() : null));
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const onFold = useCallback((key: string) => setFolded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);
  const onOpen = useCallback((path: string) => host.openNote(path), [host]);
  const onMenu = useCallback((path: string, kind: 'file' | 'directory') => host.showFileMenu(path, kind), [host]);

  const current = marks && root && marks.root === root ? marks : null;
  const tree = useMemo(() => (current ? changeTree(root, current.files) : []), [current, root]);
  const counts = useMemo(() => changeCounts(current?.files ?? []), [current]);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (body.current) sizeTreeGuides(body.current);
  }, [tree, folded]);

  if (!root) return <p className="rail-empty">Open a folder to see what changed in it.</p>;
  if (!git) return <p className="rail-empty">Changes needs to read git.</p>;
  if (!current || current.repository !== true) {
    return <p className="rail-empty" data-testid="changes-not-git">This folder is not in git, or git could not be read.</p>;
  }
  if (tree.length === 0) return <p className="rail-empty" data-testid="changes-empty">Nothing has changed since the last commit.</p>;

  const summary = [
    counts.modified ? `${counts.modified} changed` : '',
    counts.new ? `${counts.new} new` : '',
    counts.deleted ? `${counts.deleted} deleted` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className="changes-page" data-testid="changes-page">
      <p className="changes-summary" data-testid="changes-summary">{summary}</p>
      <div className="changes-body" ref={body}>
        <Level nodes={tree} depth={0} root={root} active={active || null} folded={folded} onFold={onFold} onOpen={onOpen} onMenu={onMenu} />
      </div>
    </div>
  );
}
