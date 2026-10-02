/**
 * A table you can take hold of.
 *
 * Typora grows a slim rail above the columns and beside the rows when the
 * pointer is over a table. A rail segment selects its track when clicked and
 * carries it to a new place when dragged, with a line showing where it will
 * land. Noto had the same operations on the menu and the keyboard but nothing
 * to reach for with a pointer, which is the half of table editing people
 * actually use.
 *
 * The rails are not content. They live in the node view's own element, are
 * marked so the editor ignores them, and are measured from the table's real
 * geometry each time the pointer arrives, so a column that grew while you were
 * typing has a handle the right width.
 *
 * Everything the drag writes goes inside the rails, never on the node view's
 * own element. The editor watches that element for changes it did not make and
 * rebuilds the view when it finds one, which in the middle of a drag throws the
 * drag away.
 *
 * The header row has no handle. Markdown cannot write a table without a header
 * and nothing may pass above it, so the rail beside the rows starts one row
 * down.
 */

import { addColumnAfter, addRowAfter, deleteTable } from 'prosemirror-tables';
import type { Command } from 'prosemirror-state';
import { alignColumn } from './keymap';
import { Fragment, type Node as ProseNode } from 'prosemirror-model';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { CellSelection } from 'prosemirror-tables';
import { dropIndex, movesAnything, reorder } from './table-drag';

type Axis = 'row' | 'column';

interface Drag {
  readonly axis: Axis;
  readonly index: number;
  readonly edges: readonly number[];
  /** Where the pointer went down, to tell a click from a drag. */
  readonly origin: number;
  moved: boolean;
  gap: number;
}

/** How far the pointer travels before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/**
 * The gap left at each end of a handle.
 *
 * Tracks meet edge to edge, so handles drawn to their full length join into one
 * continuous bar and stop reading as one grip per column. Taking a little off
 * each end puts a visible break between them.
 */
const HANDLE_INSET = 3;

/** The position of one cell, counted from the table's own position. */
function cellPos(table: ProseNode, tablePos: number, row: number, column: number): number {
  let pos = tablePos + 1;
  for (let r = 0; r < row; r += 1) pos += table.child(r).nodeSize;
  pos += 1;
  const line = table.child(row);
  for (let c = 0; c < column; c += 1) pos += line.child(c).nodeSize;
  return pos;
}

const ICON = (paths: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;

interface Tool {
  readonly name: string;
  readonly title: string;
  readonly icon: string;
  readonly run: Command;
}

const TOOLS: readonly Tool[] = [
  { name: 'align-left', title: 'Align column left', run: alignColumn('left'),
    icon: ICON('<path d="M2 4h12M2 8h8M2 12h12"/>') },
  { name: 'align-center', title: 'Align column center', run: alignColumn('center'),
    icon: ICON('<path d="M2 4h12M4 8h8M2 12h12"/>') },
  { name: 'align-right', title: 'Align column right', run: alignColumn('right'),
    icon: ICON('<path d="M2 4h12M6 8h8M2 12h12"/>') },
  { name: 'row', title: 'Add a row below', run: addRowAfter,
    icon: ICON('<rect x="2" y="3" width="12" height="5" rx="1"/><path d="M8 10v4M6 12h4"/>') },
  { name: 'column', title: 'Add a column after', run: addColumnAfter,
    icon: ICON('<rect x="2" y="2" width="5" height="12" rx="1"/><path d="M11 6v4M9 8h4"/>') },
  { name: 'delete', title: 'Delete the table', run: deleteTable,
    icon: ICON('<path d="M3 4h10M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4"/>') },
];

export class TableView implements NodeView {
  readonly dom: HTMLElement;

  readonly contentDOM: HTMLElement;

  private readonly table: HTMLTableElement;

  private readonly rails: HTMLElement;

  private readonly rowRail: HTMLElement;

  private readonly columnRail: HTMLElement;

  private readonly drop: HTMLElement;

  private readonly tools: HTMLElement;

  private drag: Drag | null = null;

  private node: ProseNode;

  constructor(
    node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    /** Reuse a typed stub shell so specialised remount skips replaceChild. */
    host?: HTMLElement,
  ) {
    this.node = node;
    this.dom = host ?? document.createElement('div');
    if (host) this.dom.replaceChildren();
    this.dom.className = 'noto-table-frame';

    this.rails = document.createElement('div');
    this.rails.className = 'noto-table-rails';
    this.rails.setAttribute('contenteditable', 'false');
    this.rowRail = document.createElement('div');
    this.rowRail.className = 'noto-table-rail noto-table-rail-rows';
    this.columnRail = document.createElement('div');
    this.columnRail.className = 'noto-table-rail noto-table-rail-columns';
    this.drop = document.createElement('div');
    this.drop.className = 'noto-table-drop';
    this.rails.append(this.columnRail, this.rowRail, this.drop);

    this.table = document.createElement('table');
    this.table.className = 'noto-table';
    const body = document.createElement('tbody');
    this.table.append(body);
    this.contentDOM = body;

    // Typora's table toolbar, above the table's left corner while the caret
    // is in it: the column's alignment, a row, a column, and the whole table
    // gone. Outside the editable content, and its clicks are kept from the
    // editor so the caret stays in the cell the command is about.
    this.tools = document.createElement('div');
    this.tools.className = 'noto-table-tools';
    this.tools.setAttribute('contenteditable', 'false');
    this.tools.setAttribute('role', 'toolbar');
    this.tools.setAttribute('aria-label', 'Table');
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `noto-table-tool noto-table-tool-${tool.name}`;
      button.title = tool.title;
      button.dataset.tool = tool.name;
      button.innerHTML = tool.icon;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        tool.run(this.view.state, this.view.dispatch, this.view);
        this.view.focus();
      });
      this.tools.append(button);
    }

    this.dom.append(this.rails, this.tools, this.table);
    this.dom.addEventListener('pointerenter', this.measure);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    /*
     * A change to the table ends any drag on it. The drag holds an index and a
     * set of edges measured from the shape the table had when the pointer went
     * down; against a new shape they name the wrong track, and dropping would
     * carry the wrong row somewhere nobody asked for. Undo while the pointer
     * is still held is the way to get here.
     */
    if (this.drag && node !== this.node) this.endDrag();
    this.node = node;
    // The shape may have changed under the pointer; the next entry re-measures,
    // and a rail measured for a table that no longer exists would lie.
    if (!this.drag) this.clearRails();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.rails.contains(mutation.target) || this.tools.contains(mutation.target);
  }

  /** The toolbar's events are its own; the editor would otherwise move the caret out of the cell. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.tools.contains(event.target);
  }

  destroy(): void {
    this.endDrag();
    this.dom.removeEventListener('pointerenter', this.measure);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
  }

  private clearRails(): void {
    this.rowRail.replaceChildren();
    this.columnRail.replaceChildren();
  }

  /** The edges of every row and column, as offsets inside the frame. */
  private geometry(): { rows: number[]; columns: number[] } | null {
    const rows = Array.from(this.table.rows);
    if (rows.length === 0) return null;
    const frame = this.dom.getBoundingClientRect();
    const rowEdges: number[] = [];
    for (const row of rows) rowEdges.push(row.getBoundingClientRect().top - frame.top);
    rowEdges.push(rows[rows.length - 1].getBoundingClientRect().bottom - frame.top);

    const cells = Array.from(rows[0].cells);
    const columnEdges: number[] = [];
    for (const cell of cells) columnEdges.push(cell.getBoundingClientRect().left - frame.left);
    if (cells.length > 0) {
      columnEdges.push(cells[cells.length - 1].getBoundingClientRect().right - frame.left);
    }
    return { rows: rowEdges, columns: columnEdges };
  }

  private readonly measure = (): void => {
    if (this.drag) return;
    const geometry = this.geometry();
    if (!geometry) return;
    const { rows, columns } = geometry;

    const handles: HTMLElement[] = [];
    // The header keeps its place, so only the body rows get a handle.
    for (let i = 1; i + 1 < rows.length; i += 1) {
      const handle = document.createElement('div');
      handle.className = 'noto-table-handle';
      handle.dataset.axis = 'row';
      handle.dataset.index = String(i);
      handle.style.top = `${rows[i] + HANDLE_INSET}px`;
      handle.style.height = `${rows[i + 1] - rows[i] - HANDLE_INSET * 2}px`;
      handles.push(handle);
    }
    this.rowRail.replaceChildren(...handles);

    const columnHandles: HTMLElement[] = [];
    for (let i = 0; i + 1 < columns.length; i += 1) {
      const handle = document.createElement('div');
      handle.className = 'noto-table-handle';
      handle.dataset.axis = 'column';
      handle.dataset.index = String(i);
      handle.style.left = `${columns[i] + HANDLE_INSET}px`;
      handle.style.width = `${columns[i + 1] - columns[i] - HANDLE_INSET * 2}px`;
      columnHandles.push(handle);
    }
    this.columnRail.replaceChildren(...columnHandles);
    this.columnRail.style.top = `${rows[0]}px`;
    this.rowRail.style.left = `${columns[0]}px`;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const handle = target.closest<HTMLElement>('.noto-table-handle');
    if (!handle || event.button !== 0) return;
    // A node view's own pointer handler never sees the view's `editable`, so
    // read-only has to be refused here as well or a table could still be
    // rearranged by dragging while everything else was locked.
    if (!this.view.editable) return;
    const geometry = this.geometry();
    if (!geometry) return;

    const axis = handle.dataset.axis === 'row' ? 'row' : 'column';
    const index = Number(handle.dataset.index);
    const edges = axis === 'row' ? geometry.rows : geometry.columns;
    const frame = this.dom.getBoundingClientRect();
    const origin = axis === 'row' ? event.clientY - frame.top : event.clientX - frame.left;

    event.preventDefault();
    this.drag = { axis, index, edges, origin, moved: false, gap: index };
    handle.classList.add('noto-table-handle-held');
    this.rails.dataset.dragging = axis;
    // Capture keeps the cursor while the pointer wanders off the four pixels
    // of the handle; the listeners are on the window so that they outlive it.
    handle.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.cancel);
    window.addEventListener('keydown', this.onKeyDown);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const frame = this.dom.getBoundingClientRect();
    const along = drag.axis === 'row' ? event.clientY - frame.top : event.clientX - frame.left;
    if (!drag.moved && Math.abs(along - drag.origin) < DRAG_THRESHOLD) return;
    drag.moved = true;

    // Nothing may land above the header, so the first gap a row can take is 1.
    const lowest = drag.axis === 'row' ? 1 : 0;
    drag.gap = Math.max(lowest, dropIndex(drag.edges, along));
    this.showDrop(drag);
  };

  private showDrop(drag: Drag): void {
    const geometry = this.geometry();
    if (!geometry) return;
    const at = drag.edges[drag.gap];
    this.drop.dataset.axis = drag.axis;
    this.drop.hidden = !movesAnything(drag.index, drag.gap);
    if (drag.axis === 'row') {
      this.drop.style.top = `${at}px`;
      this.drop.style.left = `${geometry.columns[0]}px`;
      this.drop.style.width = `${geometry.columns[geometry.columns.length - 1] - geometry.columns[0]}px`;
      this.drop.style.height = '';
    } else {
      this.drop.style.left = `${at}px`;
      this.drop.style.top = `${geometry.rows[0]}px`;
      this.drop.style.height = `${geometry.rows[geometry.rows.length - 1] - geometry.rows[0]}px`;
      this.drop.style.width = '';
    }
  }

  private readonly onPointerUp = (): void => {
    const drag = this.drag;
    if (!drag) return;
    /*
     * The drag is ended whatever happens. Letting a throw out of here left the
     * window listeners attached and the rail frozen, because the only place
     * that takes them off is `endDrag`.
     */
    try {
      if (drag.moved) {
        if (movesAnything(drag.index, drag.gap)) this.apply(drag.axis, drag.index, drag.gap);
      } else {
        this.select(drag.axis, drag.index);
      }
    } finally {
      this.endDrag();
    }
  };

  private readonly cancel = (): void => {
    // Nothing has been dispatched yet, so letting go is the whole undo.
    this.endDrag();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.drag) {
      event.preventDefault();
      this.endDrag();
    }
  };

  private endDrag(): void {
    const handle = this.rails.querySelector('.noto-table-handle-held');
    if (handle instanceof HTMLElement) handle.classList.remove('noto-table-handle-held');
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.cancel);
    window.removeEventListener('keydown', this.onKeyDown);
    this.drop.hidden = true;
    delete this.rails.dataset.dragging;
    this.drag = null;
  }

  /** Put the caret's selection over a whole row or column, as a click on the rail means. */
  private select(axis: Axis, index: number): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const table = this.node;
    if (!this.rectangular(table)) return;
    const width = table.child(0).childCount;
    const doc = this.view.state.doc;
    const selection = axis === 'row'
      ? CellSelection.rowSelection(
        doc.resolve(cellPos(table, pos, index, 0)),
        doc.resolve(cellPos(table, pos, index, width - 1)),
      )
      : CellSelection.colSelection(
        doc.resolve(cellPos(table, pos, 0, index)),
        doc.resolve(cellPos(table, pos, table.childCount - 1, index)),
      );
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    this.view.focus();
  }

  /**
   * Whether every row has the same cells, which the position arithmetic needs.
   *
   * A table pasted from HTML can have a merged cell, and then a row is short
   * and counting cells off the header runs past its end. The reordering
   * checked this and the selection did not, so a single click on a handle in
   * such a table threw out of the pointer handler before the drag was ended,
   * which left the window listeners attached and the rail frozen for good.
   */
  private rectangular(table: ProseNode): boolean {
    const width = table.child(0).childCount;
    for (let row = 0; row < table.childCount; row += 1) {
      if (table.child(row).childCount !== width) return false;
    }
    return true;
  }

  /** Rebuild the table with the track carried into its new place. */
  private apply(axis: Axis, from: number, gap: number): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const table = this.node;
    if (!this.rectangular(table)) return;

    const rows: ProseNode[] = [];
    if (axis === 'row') {
      const order = reorder(table.childCount, from, gap);
      for (const index of order) rows.push(table.child(index));
    } else {
      const order = reorder(table.child(0).childCount, from, gap);
      for (let r = 0; r < table.childCount; r += 1) {
        const line = table.child(r);
        rows.push(line.copy(Fragment.fromArray(order.map((i) => line.child(i)))));
      }
    }

    const transaction = this.view.state.tr.replaceWith(pos + 1, pos + 1 + table.content.size, rows);
    this.view.dispatch(transaction);
    this.view.focus();
  }
}

export function tableNodeViews() {
  return {
    table: (
      node: ProseNode,
      view: EditorView,
      getPos: () => number | undefined,
      _decorations?: unknown,
      _inner?: unknown,
      host?: HTMLElement,
    ) => new TableView(node, view, getPos, host),
  };
}
