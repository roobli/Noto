/**
 * The navigation rail.
 *
 * One region holding Files and Outline by default, with Links opt-in. Files and
 * Outline used to open as separate columns, so asking for both spent 470 pixels
 * of a 1280 pixel window on navigation and pushed the document twice. They
 * answer the same question, "where do I go next", so they share one region and
 * take turns. Links (graph / related) stays off the default path until Settings
 * turns it on.
 *
 * The rail owns the region and its header; the tree and the outline own only
 * their bodies.
 */

import { RailLinks, type RailLinksProps } from './RailLinks';
import { RailSearch, type RailSearchProps } from './RailSearch';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FileTree, type FileTreeProps } from './FileTree';
import { nestOutline, type OutlineEntry, type OutlineNode } from './outline';
import { clampRailWidth, railWidthMaxForScreen, SETTING_RANGES } from '../shared/settings/v1/contracts';
import { sizeTreeGuides } from './tree-guides';

export type RailView = 'files' | 'outline' | 'links' | 'search';

const RAIL_MIN = SETTING_RANGES.railWidth.min;

function windowWidth(): number {
  return typeof window !== 'undefined' ? window.innerWidth : 0;
}

export interface WorkspaceRailProps {
  readonly view: RailView;
  readonly onView: (view: RailView) => void;
  /** When false, the Links tab (graph / MOC / related) is not drawn. */
  readonly showLinks: boolean;
  readonly width: number;
  /** Called once when the drag ends, not per pointer move: the width follows
   *  the pointer through a CSS variable, and only the result is persisted. */
  readonly onResize: (width: number) => void;
  readonly outline: readonly OutlineEntry[];
  readonly onGoToBlock: (blockIndex: number) => void;
  /** The heading the caret is under, so the outline can say where you are. */
  readonly currentHeading?: number;
  readonly tree: FileTreeProps;
  /** The search view's own wiring; the rail only shows it. */
  readonly search: RailSearchProps;
  /** The links view's wiring, the same way. */
  readonly links: RailLinksProps;
}

function Tab({ id, current, onSelect, children, testId }: {
  id: RailView;
  current: RailView;
  onSelect: (view: RailView) => void;
  children: ReactNode;
  testId: string;
}) {
  const selected = current === id;
  return (
    <button
      type="button"
      role="tab"
      id={`rail-tab-${id}`}
      aria-selected={selected}
      aria-controls={`rail-view-${id}`}
      data-testid={testId}
      className={selected ? 'rail-tab is-current' : 'rail-tab'}
      onClick={() => onSelect(id)}
    >
      {children}
    </button>
  );
}

/** Whether the heading in front sits under this node, folded or not. */
function holdsCurrent(node: OutlineNode, current: number | undefined): boolean {
  if (current === undefined) return false;
  if (node.blockIndex === current) return true;
  return node.children.some((child) => holdsCurrent(child, current));
}

/**
 * One level of the outline.
 *
 * Same structure as the file tree, for the same reason: the connector lines are
 * drawn from the nesting, and `:last-child` is what turns a tee into a rounded
 * corner. Sharing the `tree-level` and `tree-node` classes is deliberate, so the
 * two trees in the rail cannot drift into looking like different products.
 *
 * A heading with headings under it folds, as Typora's outline folds: the
 * twisty at its left, shown when the row is hovered or the branch is closed,
 * takes the children away and the row stands for all of them. While the
 * heading in front is inside a closed branch, the closed row is the current
 * one, so the eye still finds where the caret is.
 */
function OutlineLevel({ nodes, root, onGoToBlock, current, folded, onFold }: {
  nodes: readonly OutlineNode[];
  root?: boolean;
  onGoToBlock: (blockIndex: number) => void;
  current?: number;
  folded: ReadonlySet<number>;
  onFold: (blockIndex: number, closed: boolean) => void;
}) {
  return (
    <div className={root ? 'tree-level is-root' : 'tree-level'}>
      {nodes.map((node) => {
        const branch = node.children.length > 0;
        const closed = branch && folded.has(node.blockIndex);
        const isCurrent = node.blockIndex === current || (closed && holdsCurrent(node, current));
        return (
          <div className="tree-node" key={node.blockIndex}>
            <button
              type="button"
              className={`tree-row outline-entry depth-${node.depth}${isCurrent ? ' is-current' : ''}${closed ? ' is-closed' : ''}`}
              aria-current={isCurrent ? 'true' : undefined}
              aria-expanded={branch ? !closed : undefined}
              data-testid="outline-entry"
              title={node.text}
              onClick={() => onGoToBlock(node.blockIndex)}
              onKeyDown={(event) => {
                if (!branch) return;
                if (event.key === 'ArrowLeft' && !closed) { event.preventDefault(); onFold(node.blockIndex, true); }
                if (event.key === 'ArrowRight' && closed) { event.preventDefault(); onFold(node.blockIndex, false); }
              }}
            >
              {branch
                ? (
                  // A span inside the row rather than a second button, since a
                  // button cannot hold one; the click is stopped so folding a
                  // heading does not also go to it.
                  <span
                    className={closed ? 'tree-twisty outline-twisty' : 'tree-twisty tree-twisty-open outline-twisty'}
                    data-testid="outline-twisty"
                    role="presentation"
                    onClick={(event) => { event.stopPropagation(); onFold(node.blockIndex, !closed); }}
                  />
                )
                : <span className="tree-twisty tree-twisty-blank" aria-hidden="true" />}
              <span className="tree-name">{node.text}</span>
            </button>
            {branch && !closed && (
              <OutlineLevel nodes={node.children} onGoToBlock={onGoToBlock} current={current} folded={folded} onFold={onFold} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Where the sliding rule sits, as a custom property rather than a measurement.
 *
 * The two labels are a known width apart, so their positions are arithmetic on
 * the text length rather than something to read back from the DOM after paint.
 * Measuring would mean a layout read on every switch and a frame at the wrong
 * position on the first one.
 */
const INDICATOR: Record<RailView, { left: string; width: string }> = {
  // Measured against the drawn labels: where each starts, and its width
  // less the letter-spacing that trails the last glyph.
  files: { left: '0px', width: '31px' },
  outline: { left: '48px', width: '51px' },
  links: { left: '116px', width: '34px' },
  // No rule under either label while the search has the rail.
  search: { left: '0px', width: '0px' },
};

export function WorkspaceRail({
  view, onView, showLinks, width, onResize, outline, onGoToBlock, currentHeading, tree, search, links,
}: WorkspaceRailProps) {
  const railRef = useRef<HTMLElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  /** The headings folded shut, by block. Kept while the rail lives, as Typora keeps its folds. */
  const [folded, setFolded] = useState<ReadonlySet<number>>(() => new Set());
  const fold = useCallback((blockIndex: number, closed: boolean) => {
    setFolded((current) => {
      if (current.has(blockIndex) === closed) return current;
      const next = new Set(current);
      if (closed) next.add(blockIndex); else next.delete(blockIndex);
      return next;
    });
  }, []);

  /*
   * The outline draws the same tree as the file list and needs the same
   * measurement.
   *
   * It has the same markup and the same stylesheet, so it was already drawing
   * arms and corners, but nothing sized its stems: they ran the full height of
   * every level and straight through the rounded corner at the foot of each.
   * No branch is lit here, because every level of an outline is visible at once
   * and there is no path to lead the eye along.
   */
  useEffect(() => {
    const body = outlineRef.current;
    if (body) sizeTreeGuides(body);
  }, [outline, currentHeading, view, folded]);

  /** Live drag ceiling: 35% of the window, refreshed on resize. */
  const [railMax, setRailMax] = useState(() => railWidthMaxForScreen(windowWidth()));
  useEffect(() => {
    const sync = () => setRailMax(railWidthMaxForScreen(window.innerWidth));
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  /**
   * Drag the rail wider.
   *
   * The width is written straight to the element as a custom property while the
   * pointer moves, and the setting is written once on release. Routing every
   * move through React state and IPC would put a settings round trip between
   * the pointer and the edge it is dragging, which is exactly the lag that
   * makes a resize feel broken. Max is 35% of the window, not the soft
   * absolute in SETTING_RANGES.
   */
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rail = railRef.current;
    if (!rail) return;
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = rail.getBoundingClientRect().width;
    let latest = startWidth;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      const max = railWidthMaxForScreen(window.innerWidth);
      latest = clampRailWidth(startWidth + moveEvent.clientX - startX, window.innerWidth);
      // Keep aria in step if the window resized mid-drag.
      setRailMax(max);
      rail.style.setProperty('--rail-width', `${Math.round(latest)}px`);
    };
    const finish = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      onResize(Math.round(latest));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }, [onResize]);

  /** The keyboard path, because a drag handle that only takes a pointer is
   *  a control some people simply do not have. */
  const nudge = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    const max = railWidthMaxForScreen(window.innerWidth);
    if (event.key === 'ArrowLeft') { event.preventDefault(); onResize(Math.max(RAIL_MIN, width - step)); }
    if (event.key === 'ArrowRight') { event.preventDefault(); onResize(Math.min(max, width + step)); }
  }, [onResize, width]);

  return (
    <aside ref={railRef} className="workspace-rail" aria-label="Navigation"
      style={{ '--rail-width': `${width}px` } as CSSProperties}>
      <div
        className="rail-tabs"
        role="tablist"
        aria-label="Rail view"
        style={{
          '--rail-indicator-left': INDICATOR[view].left,
          '--rail-indicator-width': INDICATOR[view].width,
        } as CSSProperties}
      >
        <Tab id="files" current={view} onSelect={onView} testId="rail-files">Files</Tab>
        <Tab id="outline" current={view} onSelect={onView} testId="outline-toggle">Outline</Tab>
        {showLinks && (
          <Tab id="links" current={view} onSelect={onView} testId="links-toggle">Links</Tab>
        )}
        <button type="button" data-testid="rail-search"
          className={view === 'search' ? 'icon-button rail-search is-on' : 'icon-button rail-search'}
          aria-label="Search in notes" aria-pressed={view === 'search'} title="Search in notes (⇧⌘F)"
          onClick={() => onView(view === 'search' ? 'files' : 'search')}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.25 10.25 3.5 3.5" />
          </svg>
        </button>
      </div>

      {view === 'files' && (
        <div className="rail-view" id="rail-view-files" role="tabpanel" aria-labelledby="rail-tab-files">
          <FileTree {...tree} />
        </div>
      )}
      {showLinks && view === 'links' && (
        <div className="rail-view" id="rail-view-links" role="tabpanel" aria-labelledby="rail-tab-links">
          <RailLinks {...links} />
        </div>
      )}
      {view === 'search' && (
        <div className="rail-view" id="rail-view-search">
          <RailSearch {...search} />
        </div>
      )}
      {view === 'outline' && (
          <div className="rail-view" id="rail-view-outline" role="tabpanel" aria-labelledby="rail-tab-outline"
            data-testid="outline-panel">
            {outline.length === 0
              ? <p className="rail-empty">This document has no headings.</p>
              : (
                <nav className="outline-body" ref={outlineRef}>
                  <OutlineLevel nodes={nestOutline(outline)} root onGoToBlock={onGoToBlock} current={currentHeading}
                    folded={folded} onFold={fold} />
                </nav>
              )}
          </div>
        )}


      <div
        className="rail-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Rail width"
        aria-valuenow={width}
        aria-valuemin={RAIL_MIN}
        aria-valuemax={railMax}
        tabIndex={0}
        data-testid="rail-resize"
        onPointerDown={startResize}
        onKeyDown={nudge}
      />
    </aside>
  );
}
