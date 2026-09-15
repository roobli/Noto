/**
 * The editor.
 *
 * Owns a ProseMirror `EditorView` built on Noto's own schema, so every markdown
 * construct the parser produces is editable rather than frozen as source.
 *
 * Two properties are load bearing:
 *
 * - Capture is cheap. A block whose ProseMirror node is structurally identical
 *   to the one it was built from is reported using its original source text,
 *   with no serialization at all. Only blocks the user actually touched are
 *   rendered back to markdown, which is what keeps saving a large document
 *   proportional to the size of the edit rather than the size of the file.
 * - Capture is refused mid composition. An IME candidate window holds text that
 *   is not committed yet, and saving it would write a half finished word.
 */

import { triggerRange, wikiLinkText } from './wiki-trigger';
import { droppedNote } from './dropped-note';
import { tocBlockPlugin } from './toc-block';
import { footnoteHoverPlugin } from './footnote-hover';
import { sliceFromText } from './paste-text';
import { EditorState, Selection, type Plugin, type Transaction, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, redo, undo } from 'prosemirror-history';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { columnResizing, tableEditing } from 'prosemirror-tables';
import type { Node as ProseNode } from 'prosemirror-model';
import { notoSchema } from '../../../shared/markdown/v3/pm/schema';
import { blockFromSpan, docFromSpans } from '../../../shared/markdown/v3/pm/from-mdast';
import { blockToMarkdown } from '../../../shared/markdown/v3/pm/to-mdast';
import { blockSpansFromWire, parseSingleBlock, splitBlocks, type BlockSpan } from '../../../shared/markdown/v3/blocks';
import { isRoobliMdEngine } from '../../../shared/markdown/v3/engine-flag';
import { PriorSplitCache } from '../../../shared/markdown/v3/prior-split-cache';
import { parseDocumentSpans } from './parse-document';
import { toLf } from '../../../shared/markdown/v3/line-endings';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoDocumentWire,
  type NotoTargetEnvelope,
  type NotoTransaction,
} from '../../../shared/markdown/v3/contracts';
import {
  encodeSourceBuffer,
  sourceHasFinalNewline,
  sourceSettleKind,
} from '../../source-mode-text';
import { captureMarkdown, captureTransaction, type CaptureStats, type PristineBlock } from './capture';
import type { NotoEditorPort } from './NotoEditorPort';
import { createOriginPlugin, getBlockOrigins, rebaseOrigins } from './origin-plugin';
import { notoInputRules, type InputRuleOptions } from './input-rules';
import { EDITOR_COMMANDS, insertTable, notoKeymap } from './keymap';
import { sortTasks, toggleTaskStatus, type TaskStampOptions } from './todo-manager';
import { activeNodePlugin } from './active-node-plugin';
import { viewportLayoutPlugin } from './viewport-layout';
import { stubbableNodeViews, stubbingEnabled, viewportStubPlugin } from './viewport-stub';
import { taskClickPlugin } from './task-click';
import { indexBlockPlugin } from './index-block';
import { imageFromTransfer } from './image-drop';
import { documentDomToHtml, sliceToHtml, sliceToPlainText } from './clipboard';
import { alertPlugin } from './alert-plugin';
import { RESCAN, typoraMarksKey, typoraMarksPlugin } from './typora-marks-plugin';
import { SIDENOTE_RESCAN, sidenoteKey, sidenotePlugin } from './sidenote-plugin';
import { ALL_MARK_KINDS, type TyporaMarkKinds } from './typora-marks';
import { typewriterPlugin } from './typewriter-plugin';
import { autoPairPlugin } from './auto-pair';
import { mathEditingPlugin, mathNodeViews } from './math-view';
import { tableNodeViews } from './table-view';
import { fenceNodeViews } from './fence-view';
import type { ImageContext } from './image-source';
import { htmlNodeViews } from './html-view';
import { imageNodeViews, type Refreshable } from './image-view';
import type { SearchOptions } from './search';
import {
  getSearchState,
  goToMatch,
  replaceActive,
  replaceAll,
  searchPlugin,
  selectActiveMatch,
  setSearch,
} from './search-plugin';
import { syntaxHighlightPlugin } from './highlight';
import { wikiLinkPlugin } from './wiki-link-plugin';
import { followLinkPlugin, linkEditorPlugin } from './link-plugin';
import { countWords, type DocumentCount } from './word-count';
import { sliceToMarkdown } from './clipboard';

/** How long after the last keystroke the document is counted. */
const COUNT_DELAY_MS = 400;

/* The three substitutions are booleans here and functions on the rules, which
   read them each time so a change of setting reaches an editor already open. */
export interface NotoEditorOptions extends Omit<InputRuleOptions, 'smartQuotes' | 'smartDashes' | 'smartEllipsis'> {
  readonly mac: boolean;
  /** Native spell checking, which the user can turn off in settings. */
  readonly spellCheck?: boolean;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** Fired for every transaction that changed the document. */
  readonly onDocumentChanged?: () => void;
  readonly onError?: (message: string) => void;
  /**
   * The index of the top level block the caret is in, when it changes.
   *
   * The outline uses it to say which heading you are under, which is the one
   * question a list of headings is asked while you are writing rather than
   * navigating.
   */
  readonly onActiveBlockChanged?: (index: number) => void;
  /** Cmd or Ctrl clicking an ordinary `[text](address)` link. */
  readonly onFollowLink?: (href: string) => void;
  /** A markdown file dropped on the editor, which is a note to open rather than content. */
  readonly onDropNote?: (file: File) => void;
  /** The document's size, after typing has stopped rather than during it. */
  readonly onCountChanged?: (count: DocumentCount) => void;
  /** Cmd or Ctrl clicking a `[[wiki link]]`. Absent means links stay inert. */
  readonly onFollowWikiLink?: (target: string) => void;
  /** Two brackets were typed, which is a reader asking which note they mean. */
  readonly onWikiTrigger?: () => void;
  /** Where relative images resolve from, and whether web images load. */
  readonly images?: ImageContext;
  readonly smartQuotes?: boolean;
  readonly smartDashes?: boolean;
  readonly smartEllipsis?: boolean;
  /**
   * Hands pasted or dropped picture bytes to main, which decides where they go.
   *
   * Absent means a picture cannot be pasted, which is what a test harness with
   * no main process wants: the paste falls through to ProseMirror's own
   * handling rather than failing.
   */
  readonly onWriteImage?: (bytes: Uint8Array) => Promise<InsertedImage | null>;
  /** Command and a bracket, when the caret is not in a list to indent. */
  readonly onWidthStep?: (direction: 1 | -1) => void;
}

/** What main says it wrote: the text for the brackets, and the alt for it. */
export interface InsertedImage {
  readonly reference: string;
  readonly alt: string;
}

export class NotoEditor implements NotoEditorPort {
  private view: EditorView | null = null;
  private document: NotoDocumentWire;
  private substitutions = { quotes: false, dashes: false, ellipsis: false };
  private typewriter = false;
  private autoPair = true;
  /** Append ` ✅ YYYY-MM-DD` when a task is checked. */
  private todoCheckTime = true;

  /** Which of Typora's inline marks are read; a preference, read at each scan. */
  private markKinds: TyporaMarkKinds = ALL_MARK_KINDS;
  private sidenotes = true;
  private activeBlock = -1;
  /* Bumped by every change, so a picture that arrives after the document moved
     under it is put where the caret is now rather than at a stale offset. */
  private docVersion = 0;
  /** Reading rather than writing. Nothing about the file changes with it. */
  private readOnly = false;
  /**
   * What the next save should make the file's endings and last byte.
   *
   * Held here rather than written straight through, because neither is a
   * preference and neither reaches disk on its own: they are a pending change
   * to this file that the ordinary save carries, exactly as Typora does it.
   * Null means whatever the file already is.
   */
  private target: NotoTargetEnvelope | null = null;
  /**
   * LF buffer waiting for a `mode: 'source'` save.
   *
   * Set only when Source Mode settled a change the block model cannot express
   * (gap / leading / extra trailing). Cleared on commit or when a later settle
   * no longer needs the escape. Null means capture stays on the blocks path.
   */
  private pendingSource: string | null = null;
  private imageContext: ImageContext;
  /** The pictures on screen, so a changed context can redraw them and nothing else. */
  private readonly imageViews = new Set<Refreshable>();
  private baselineDoc: ProseNode;
  private dirty = false;
  private readonly host: HTMLElement;
  private readonly options: NotoEditorOptions;
  /** What each accepted block looked like, keyed by block id. */
  private pristine = new Map<string, PristineBlock>();
  /**
   * Last structural `@roobli/md` split for flagged `replaceMarkdown`.
   * Unused while the micromark engine is selected.
   */
  private readonly priorSplit = new PriorSplitCache();
  /** True while `replaceMarkdown` is dispatching, so typing invalidation skips. */
  private replaceInFlight = false;

  /**
   * @param spans Pre-parsed block spans from `parseDocumentSpans`. Open and
   *   reload produce these off the UI thread; omitting them falls back to a
   *   synchronous split, which paste and small fragment paths still use.
   */
  constructor(
    host: HTMLElement,
    document: NotoDocumentWire,
    options: NotoEditorOptions,
    spans?: readonly BlockSpan[],
  ) {
    this.document = document;
    this.options = options;
    this.host = host;
    this.substitutions = {
      quotes: options.smartQuotes === true,
      dashes: options.smartDashes === true,
      ellipsis: options.smartEllipsis === true,
    };
    this.imageContext = options.images ?? { documentDir: null, remote: true };

    const doc = this.buildDoc(document, spans);
    this.baselineDoc = doc;

    this.view = new EditorView(host, {
      state: EditorState.create({ doc, plugins: this.plugins(document) }),
      dispatchTransaction: (transaction) => this.apply(transaction),
      attributes: { spellcheck: String(this.options.spellCheck ?? true) },
      // The one place read-only is enforced for typing. The node views that
      // take pointer input have to refuse separately, because a node view's
      // own handlers never see this.
      editable: () => !this.readOnly,
      // What leaves on the clipboard is the markdown, not the words without it.
      clipboardTextSerializer: (slice) => sliceToMarkdown(slice),
      clipboardTextParser: (text, $context) => sliceFromText(text, $context),
      handleTextInput: (view, from, _to, text) => {
        // The second of two brackets: asked after the transaction, since the
        // question is about the document the keystroke is making, not the one
        // it is leaving. Never handled here, so typing is untouched either way.
        if (text === '[' && view.state.doc.textBetween(Math.max(0, from - 1), from) === '[') {
          queueMicrotask(() => this.options.onWikiTrigger?.());
        }
        return false;
      },
      handlePaste: (view, event) => {
        if (this.handleTransfer(view, event.clipboardData, null)) return true;
        // Text with no richer form is markdown and is read as such here,
        // whole. Left to the library, the text would be read and then opened
        // as deep as it goes, so a pasted heading's words would land inside
        // the paragraph the caret is in. Rich text, and the editor's own
        // copies, keep the library's path.
        const data = event.clipboardData;
        if (!data || data.types.includes('text/html')) return false;
        const text = data.getData('text/plain');
        if (text.length === 0) return false;
        this.pasteText(text);
        return true;
      },
      handleDrop: (view, event) => {
        const note = droppedNote((event as DragEvent).dataTransfer?.files);
        if (note && this.options.onDropNote) {
          event.preventDefault();
          this.options.onDropNote(note);
          return true;
        }
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
        return this.handleTransfer(view, (event as DragEvent).dataTransfer, at);
      },
      nodeViews: this.nodeViews(doc.childCount),
    });
    // Where the caret starts, said once, so the marker is there before any
    // key is pressed. Without it the attribute exists only after something
    // has moved, and "the caret has not moved yet" reads as "there is no
    // editor" to anything waiting on it.
    this.host.dataset.caret = String(this.view.state.selection.from);
    // The first count is for the document as opened, not for a change to it.
    this.scheduleCount();
  }

  private nodeViews(childCount: number) {
    const specialised = {
      ...mathNodeViews(),
      ...fenceNodeViews(),
      ...imageNodeViews(this.imageViews, () => this.imageContext),
      ...htmlNodeViews(this.imageViews, () => this.imageContext),
      ...tableNodeViews(),
    };
    // Only mount stubbable node views on documents that will actually stub.
    // Medium notes stay on ProseMirror's default path so this layer cannot
    // regress the size class that already sits inside a frame.
    if (!stubbingEnabled(childCount)) return specialised;
    return {
      ...stubbableNodeViews(),
      ...specialised,
    };
  }

  private plugins(document: NotoDocumentWire): Plugin[] {
    return [
      createOriginPlugin(document.origins),
      // A getter, not a value: the setting can change while the editor is open
      // and the rules must follow without the editor being rebuilt.
      notoInputRules({
        smartQuotes: () => this.substitutions.quotes,
        smartDashes: () => this.substitutions.dashes,
        smartEllipsis: () => this.substitutions.ellipsis,
      }),
      ...notoKeymap({
        mac: this.options.mac,
        onWidthStep: (d) => this.options.onWidthStep?.(d),
        taskStamp: this.taskStampOptions(),
      }),
      history(),
      dropCursor({ color: 'var(--accent)' }),
      gapCursor(),
      alertPlugin(),
      typoraMarksPlugin(() => this.markKinds),
      sidenotePlugin(() => this.sidenotes),
      typewriterPlugin(() => this.typewriter),
      autoPairPlugin(() => this.autoPair),
      columnResizing(),
      tableEditing(),
      activeNodePlugin(),
      viewportLayoutPlugin(),
      viewportStubPlugin(),
      taskClickPlugin(this.taskStampOptions()),

      wikiLinkPlugin({ onFollow: (target) => this.options.onFollowWikiLink?.(target) }),
      indexBlockPlugin({ onFollow: (target) => this.options.onFollowWikiLink?.(target) }),
      footnoteHoverPlugin(),
      tocBlockPlugin({ onGo: (blockIndex) => this.focusBlock(blockIndex) }),
      linkEditorPlugin(),
      followLinkPlugin({ onFollow: (href) => this.options.onFollowLink?.(href) }),
      mathEditingPlugin(),
      searchPlugin(),
      syntaxHighlightPlugin(),
    ];
  }

  /**
   * Build the ProseMirror document and record what each block started as.
   *
   * The block markdown is recovered by splitting the text rather than being
   * sent over IPC, which keeps one copy of the file on the wire instead of two.
   * Full-document opens pass spans already produced off the UI thread; a missing
   * list still splits here so small call sites stay synchronous.
   */
  private buildDoc(document: NotoDocumentWire, spans?: readonly BlockSpan[]): ProseNode {
    const resolved = spans ?? splitBlocks(document.text).spans;
    const doc = docFromSpans(resolved);

    this.pristine = new Map();
    doc.forEach((node, _offset, index) => {
      const origin = document.origins[index];
      const span = resolved[index];
      if (origin && span) this.pristine.set(origin.blockId, { node, markdown: toLf(span.markdown) });
    });

    // Flagged path: seed prior split from the open/reload spans (no extra parse).
    if (isRoobliMdEngine()) {
      this.priorSplit.seedFromSpans(document.text, resolved);
    } else {
      this.priorSplit.invalidate();
    }

    return doc;
  }

  private countTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A paste or a drop that carries a picture.
   *
   * Returns true only when this took the event over. Everything else falls
   * through to ProseMirror, which handles ordinary text and HTML correctly and
   * should go on doing so.
   *
   * The write is asynchronous and the insertion happens after it, so the
   * position is captured now and used later only if the document has not moved
   * in between. That is the whole reason `docVersion` exists.
   */
  private handleTransfer(view: EditorView, data: DataTransfer | null, dropAt: number | null): boolean {
    const found = imageFromTransfer(data);
    if (!found) return false;

    const at = dropAt ?? view.state.selection.from;
    if (!this.canInsertImageAt(view, at)) {
      // Inside a fence or display maths the text is literal source and takes no
      // inline node at all, so say why rather than dropping the paste silently.
      this.options.onError?.('A picture cannot go here.');
      return true;
    }

    if (found.kind === 'remote') {
      this.insertImage({ reference: found.href, alt: '' }, at, this.docVersion);
      return true;
    }
    if (!this.options.onWriteImage) return false;

    const version = this.docVersion;
    void (async () => {
      try {
        const bytes = new Uint8Array(await found.file.arrayBuffer());
        const written = await this.options.onWriteImage?.(bytes);
        if (written) this.insertImage(written, at, version);
      } catch {
        this.options.onError?.('That picture could not be read.');
      }
    })();
    return true;
  }

  /** Whether an inline picture is allowed at `at`, which a fence does not allow. */
  private canInsertImageAt(view: EditorView, at: number): boolean {
    const $at = view.state.doc.resolve(at);
    return $at.parent.type.spec.code !== true
      && $at.parent.canReplaceWith($at.index(), $at.index(), notoSchema.nodes.image);
  }

  /**
   * Put the picture in.
   *
   * When the document changed while the bytes were being written, the captured
   * offset now points at different text, so the caret is used instead. Both are
   * better than writing into the middle of a word the reader has since typed.
   */
  private insertImage(image: InsertedImage, at: number, version: number): void {
    const view = this.view;
    if (!view) return;
    const target = version === this.docVersion ? at : view.state.selection.from;
    if (!this.canInsertImageAt(view, target)) {
      this.options.onError?.('A picture cannot go here.');
      return;
    }
    const node = notoSchema.nodes.image.create({
      src: image.reference,
      alt: image.alt,
      title: null,
      referenceType: null,
      identifier: '',
      label: '',
    });
    // Replacing the selection when the caret is where the picture goes, so
    // pasting over selected text behaves the way pasting anything else does.
    const transaction = target === view.state.selection.from
      ? view.state.tr.replaceSelectionWith(node, false)
      : view.state.tr.insert(target, node);
    view.dispatch(transaction.scrollIntoView());
    view.focus();
  }

  /**
   * Read without writing.
   *
   * The document is untouched by this: nothing is saved, nothing is marked, and
   * turning it off leaves the note exactly as it was. It exists for the times a
   * note is open to be consulted rather than written, where a stray keystroke
   * is the thing to prevent.
   */
  setReadOnly(value: boolean): void {
    if (this.readOnly === value) return;
    this.readOnly = value;
    const view = this.view;
    if (!view) return;
    // `editable` is a function the view calls, so it has to be asked again.
    view.setProps({ editable: () => !this.readOnly });
    view.dom.classList.toggle('noto-read-only', value);
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** The endings and last byte this file has, or is about to be given. */
  get envelope(): NotoTargetEnvelope {
    return this.target ?? {
      lineEnding: this.document.envelope.lineEnding,
      hasFinalNewline: this.document.envelope.hasFinalNewline,
    };
  }

  /**
   * Ask for the file to be written with different endings, or with or without
   * a final newline.
   *
   * Nothing is written now. The document is marked as having unsaved changes,
   * so the ordinary save carries it and the reader can see there is something
   * to save, which is what Typora does and is the honest presentation: this is
   * a change to the file, not a setting about the app.
   *
   * Asking for what the file already is clears the pending change rather than
   * recording a no-op, so toggling back and forth leaves nothing behind.
   */
  setEnvelope(next: Partial<NotoTargetEnvelope>): boolean {
    if (this.readOnly) return false;
    const current = this.envelope;
    const wanted: NotoTargetEnvelope = {
      lineEnding: next.lineEnding ?? current.lineEnding,
      hasFinalNewline: next.hasFinalNewline ?? current.hasFinalNewline,
    };
    const own = this.document.envelope;
    const same = wanted.lineEnding === own.lineEnding && wanted.hasFinalNewline === own.hasFinalNewline;
    const before = this.target;
    this.target = same ? null : wanted;
    if (before?.lineEnding === this.target?.lineEnding
      && before?.hasFinalNewline === this.target?.hasFinalNewline) return false;

    // Dirty for as long as the file on disk does not match what was asked for.
    // A document with no other change would otherwise offer nothing to save.
    if (this.target && !this.dirty) {
      this.dirty = true;
      this.options.onDirtyChange?.(true);
    }
    return true;
  }

  /**
   * The whole document as HTML, for export.
   *
   * From what is drawn, not from the schema: the node views have already had
   * KaTeX render the maths, Prism colour the code and mermaid draw the
   * diagrams, and none of that is recoverable from the schema alone.
   */
  documentHtml(): string | null {
    const view = this.view;
    return view ? documentDomToHtml(view.dom as HTMLElement) : null;
  }

  /** What is selected, as markdown, HTML, or the words on their own. */
  copySelection(as: 'markdown' | 'html' | 'plain'): string | null {
    const view = this.view;
    if (!view) return null;
    const slice = view.state.selection.content();
    if (slice.content.size === 0) return null;
    if (as === 'html') return sliceToHtml(slice);
    if (as === 'plain') return sliceToPlainText(slice);
    return sliceToMarkdown(slice);
  }

  /** Insert a picture main already wrote, for the Insert Image menu command. */
  insertWrittenImage(image: InsertedImage): void {
    const view = this.view;
    if (!view) return;
    this.insertImage(image, view.state.selection.from, this.docVersion);
  }

  private apply(transaction: Transaction): void {
    const view = this.view;
    if (!view) return;
    view.updateState(view.state.apply(transaction));
    // Where the caret is, on the host, so what drives the editor from outside
    // can wait for the editor to have learned of a selection the browser has
    // already moved: the two are a moment apart, and a key or a paste in that
    // moment lands where the caret was.
    this.host.dataset.caret = String(this.view?.state.selection.from ?? 0);
    this.reportActiveBlock();
    if (!transaction.docChanged) return;
    this.docVersion += 1;
    // WYSIWYG edits (and paste) diverge from the cached structural split.
    // replaceMarkdown sets replaceInFlight so its own dispatch does not clear.
    if (!this.replaceInFlight && isRoobliMdEngine()) {
      this.priorSplit.invalidate();
    }
    this.refreshDirty();
    // Every change, not only the transition into dirty. Automatic saving has to
    // debounce against typing, and a flag that flips once at the first
    // keystroke cannot tell it when typing stopped.
    this.options.onDocumentChanged?.();
    this.scheduleCount();
  }

  /**
   * Count the document once typing has stopped.
   *
   * Never on the keystroke. A megabyte of prose takes about 37 milliseconds to
   * count, which is nothing to wait for after a pause and far too much to pay
   * for a letter. The timer restarts on every change, so a burst of typing
   * costs one count.
   */
  private scheduleCount(): void {
    if (!this.options.onCountChanged) return;
    if (this.countTimer !== null) clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      this.reportCount();
    }, COUNT_DELAY_MS);
  }

  private reportCount(): void {
    const view = this.view;
    if (!view || !this.options.onCountChanged) return;
    this.options.onCountChanged(countWords(
      view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'),
      view.state.doc.childCount,
    ));
  }

  /** Told only when it changes: this runs on every transaction, typing included. */
  private reportActiveBlock(): void {
    const view = this.view;
    if (!view || !this.options.onActiveBlockChanged) return;
    const { $from } = view.state.selection;
    const index = $from.index(0);
    if (index === this.activeBlock) return;
    this.activeBlock = index;
    this.options.onActiveBlockChanged(index);
  }

  private refreshDirty(): void {
    const view = this.view;
    if (!view) return;
    // While clean, any document change makes it dirty without a comparison.
    // While dirty, compare so that undoing back to the saved state clears it.
    // `doc.eq` looks expensive here but is not: ProseMirror reuses the nodes an
    // edit did not touch, so comparing a document against its saved state is a
    // walk of pointer comparisons. Measured, adding a size precheck in front of
    // it changed nothing.
    // A pending change to the file's endings keeps it dirty even when the
    // document itself is back where it started: there is still something to
    // write, and it is not in the document.
    const next = this.dirty
      ? this.target !== null || this.pendingSource !== null || !view.state.doc.eq(this.baselineDoc)
      : true;
    if (next === this.dirty) return;
    this.dirty = next;
    this.options.onDirtyChange?.(next);
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get isComposing(): boolean {
    return this.view?.composing ?? false;
  }

  get acceptedDocument(): NotoDocumentWire {
    return this.document;
  }

  /**
   * Insert text at the caret, as one undoable step.
   *
   * Used by quick open to write a wiki link. It goes through a transaction like
   * any edit, so it is undoable, it marks the document dirty, and the saved
   * bytes come from the same serializer as anything typed by hand.
   *
   * Deliberately not on `NotoEditorPort`. The port is the plugin API, and
   * inserting arbitrary text at the caret is a capability no plugin has asked
   * for; the shell holds the editor itself and does not need the port to reach
   * it.
   */
  insertText(text: string): boolean {
    const view = this.view;
    if (!view || text.length === 0) return false;
    const { from, to } = view.state.selection;
    view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
    view.focus();
    return true;
  }

  focus(): void {
    this.view?.focus();
  }

  /**
   * Put the caret at the start of a top level block and scroll it into view.
   *
   * Used by the outline. Moving the selection rather than only scrolling means
   * the user can keep typing where they landed.
   */
  focusBlock(index: number): void {
    const view = this.view;
    if (!view || index < 0 || index >= view.state.doc.childCount) return;
    let position = 0;
    for (let current = 0; current < index; current += 1) position += view.state.doc.child(current).nodeSize;
    const selection = Selection.near(view.state.doc.resolve(Math.min(position + 1, view.state.doc.content.size)));
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    view.focus();
  }

  /**
   * Show the block holding the caret as raw markdown, or render it again.
   *
   * Per block rather than per document, because the point is to reach into one
   * awkward construct (a fence with odd indentation, a table you would rather
   * type than tab through) without losing the rendered view of everything else.
   *
   * Returns false when the toggle cannot be applied, which happens if the
   * hand-edited text no longer parses as exactly one block. Refusing is the
   * honest outcome: silently splitting the user's block would change the
   * document's structure behind their back.
   */
  /**
   * Run one of the block-shaping commands by name.
   *
   * The menu and the keyboard reach the same code this way: a menu item that
   * reimplemented what a binding does would be a second implementation to
   * keep in step. False when the command has nothing to do where the caret
   * is, which is what lets the caller say so rather than pretending.
   */
  runCommand(name: string): boolean {
    const view = this.view;
    if (!view) return false;
    // Every editor command changes the document, so read-only refuses them all
    // rather than each one having to remember to check.
    if (this.readOnly) return false;
    const stamp = this.taskStampOptions();
    const command = name === 'task-toggle' ? toggleTaskStatus(undefined, stamp)
      : name === 'task-complete' ? toggleTaskStatus(true, stamp)
      : name === 'task-incomplete' ? toggleTaskStatus(false, stamp)
      : name === 'sort-tasks' ? sortTasks
      : EDITOR_COMMANDS[name];
    if (!command) return false;
    const ran = command(view.state, view.dispatch, view);
    if (ran) view.focus();
    return ran;
  }

  /** Options the check-stamp path reads on every tick. */
  private taskStampOptions(): TaskStampOptions {
    return {
      enabled: () => this.todoCheckTime,
      now: () => new Date(),
    };
  }

  toggleSourceAtSelection(): boolean {
    const view = this.view;
    if (!view) return false;
    const { $from } = view.state.selection;
    // Depth 1 is the top level block; source mode is a block level idea.
    if ($from.depth < 1) return false;
    const index = $from.index(0);
    const node = view.state.doc.child(index);

    let position = 0;
    for (let current = 0; current < index; current += 1) position += view.state.doc.child(current).nodeSize;

    const schema = view.state.schema;
    let replacement: ProseNode;
    if (node.type.name === 'source_block') {
      const markdown = node.textContent;
      const span = parseSingleBlock(markdown);
      if (!span) return false;
      replacement = blockFromSpan(span);
    } else {
      const markdown = blockToMarkdown(node);
      replacement = schema.nodes.source_block.create(
        { originalKind: node.type.name },
        markdown.length > 0 ? schema.text(markdown) : undefined,
      );
    }

    const transaction = view.state.tr.replaceWith(position, position + node.nodeSize, replacement);
    transaction.setSelection(Selection.near(transaction.doc.resolve(position + 1)));
    view.dispatch(transaction.scrollIntoView());
    view.focus();
    return true;
  }

  /** Whether the caret currently sits in a block shown as raw markdown. */
  get isSourceAtSelection(): boolean {
    const view = this.view;
    if (!view) return false;
    const { $from } = view.state.selection;
    if ($from.depth < 1) return false;
    return view.state.doc.child($from.index(0)).type.name === 'source_block';
  }

  /**
   * Point the find bar at a query.
   *
   * Returns how many matches there are and which one is current, so the shell
   * can show "3 of 17" without keeping its own copy of the document.
   */
  search(options: SearchOptions): { matches: number; active: number } {
    const view = this.view;
    if (!view) return { matches: 0, active: -1 };
    view.dispatch(setSearch(view.state.tr, { options }));
    const state = getSearchState(view.state);
    return { matches: state.matches.length, active: state.active };
  }

  /** Move to the next or previous match and select it. */
  goToMatch(direction: 'forward' | 'backward'): { matches: number; active: number } {
    const view = this.view;
    if (!view) return { matches: 0, active: -1 };
    view.dispatch(goToMatch(view.state.tr, direction));
    view.dispatch(selectActiveMatch(view.state, view.state.tr));
    const state = getSearchState(view.state);
    return { matches: state.matches.length, active: state.active };
  }

  /** Replace the current match, or every match. Returns how many changed. */
  replace(replacement: string, scope: 'one' | 'all'): number {
    const view = this.view;
    if (!view) return 0;
    const before = getSearchState(view.state).matches.length;
    const transaction = scope === 'all'
      ? replaceAll(view.state, replacement)
      : replaceActive(view.state, replacement);
    if (!transaction) return 0;
    view.dispatch(transaction);
    return scope === 'all' ? before : 1;
  }

  /**
   * Undo or redo through ProseMirror's history.
   *
   * The application menu routes here rather than using Electron's undo role,
   * which would run the browser's undo against the contenteditable and leave
   * the editor's own history untouched.
   */
  history(direction: 'undo' | 'redo'): boolean {
    const view = this.view;
    if (!view) return false;
    const command = direction === 'undo' ? undo : redo;
    return command(view.state, view.dispatch);
  }

  /**
   * Apply settings to a live editor.
   *
   * Rebuilding the editor would apply them too, and would also throw away the
   * user's undo history and cursor, so a preference change must never cost
   * them that. Spell checking is a view property, and smart typography is read
   * by the input rules on each keystroke, so both take effect at once.
   */
  applySettings(settings: {
    spellCheck?: boolean;
    markHighlight?: boolean;
    markSuperscript?: boolean;
    markSubscript?: boolean;
    sidenotes?: boolean;
    smartQuotes?: boolean;
    smartDashes?: boolean;
    smartEllipsis?: boolean;
    remoteImages?: boolean;
    typewriterMode?: boolean;
    autoPair?: boolean;
    todoCheckTime?: boolean;
  }): void {
    if (settings.autoPair !== undefined) {
      this.autoPair = settings.autoPair;
    }
    if (settings.todoCheckTime !== undefined) {
      this.todoCheckTime = settings.todoCheckTime;
    }
    if (settings.typewriterMode !== undefined) {
      this.typewriter = settings.typewriterMode;
    }
    const marks = {
      highlight: settings.markHighlight ?? this.markKinds.highlight,
      superscript: settings.markSuperscript ?? this.markKinds.superscript,
      subscript: settings.markSubscript ?? this.markKinds.subscript,
    };
    const marksChanged = marks.highlight !== this.markKinds.highlight
      || marks.superscript !== this.markKinds.superscript
      || marks.subscript !== this.markKinds.subscript;
    this.markKinds = marks;
    const sidenotesChanged = settings.sidenotes !== undefined && settings.sidenotes !== this.sidenotes;
    if (settings.sidenotes !== undefined) this.sidenotes = settings.sidenotes;
    if (settings.smartQuotes !== undefined) this.substitutions.quotes = settings.smartQuotes;
    if (settings.smartDashes !== undefined) this.substitutions.dashes = settings.smartDashes;
    if (settings.smartEllipsis !== undefined) this.substitutions.ellipsis = settings.smartEllipsis;
    const view = this.view;
    if (!view) return;
    if (marksChanged) {
      // A transaction that changes nothing, carrying the one instruction the
      // marks plugin needs: read the document again. It costs the document
      // nothing and stays out of the undo history.
      view.dispatch(view.state.tr.setMeta(typoraMarksKey, RESCAN).setMeta('addToHistory', false));
    }
    if (sidenotesChanged) {
      view.dispatch(view.state.tr.setMeta(sidenoteKey, SIDENOTE_RESCAN).setMeta('addToHistory', false));
    }
    if (settings.remoteImages !== undefined && settings.remoteImages !== this.imageContext.remote) {
      this.imageContext = { ...this.imageContext, remote: settings.remoteImages };
      this.refreshImages();
    }
    if (settings.spellCheck === undefined) return;
    view.setProps({ attributes: { spellcheck: String(settings.spellCheck) } });
  }

  /**
   * Draw the images again.
   *
   * For when what main will serve has changed under a note that is already
   * open: a folder opened after the note means a picture in a sibling folder
   * that was refused a moment ago is allowed now, and a placeholder that
   * stayed "not found" until the note was reopened would be wrong. Only the
   * images are touched; the rest of the document is not redrawn.
   */
  refreshImages(): void {
    for (const image of this.imageViews) image.refresh();
  }

  /** Drop the highlight, for when the find bar closes. */
  clearSearch(): void {
    const view = this.view;
    if (!view) return;
    view.dispatch(setSearch(view.state.tr, {
      options: { query: '', caseSensitive: false, wholeWord: false, regex: false },
    }));
  }

  /** A table of the size the dialog asked for, where the caret is. */
  insertTable(rows: number, columns: number): boolean {
    const view = this.view;
    if (!view || this.readOnly) return false;
    const ran = insertTable(rows, columns)(view.state, view.dispatch, view);
    if (ran) view.focus();
    return ran;
  }

  /**
   * Add markdown to the end of the note, as blocks of its own.
   *
   * Not a paste at the end: a paste joins the paragraph it lands in, which
   * is right for a phrase and wrong for a line appended to a note, where
   * what was meant is a new paragraph after the last one.
   */
  appendMarkdown(markdown: string): boolean {
    const view = this.view;
    if (!view || this.readOnly) return false;
    const blocks = splitBlocks(toLf(markdown)).spans.map(blockFromSpan);
    if (blocks.length === 0) return false;
    const at = view.state.doc.content.size;
    const tr = view.state.tr.insert(at, blocks);
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.doc.content.size), -1));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  /**
   * Put a wiki link where the brackets were typed.
   *
   * The brackets go with it, and so does the pair auto-pairing added, so what
   * is left is the link and nothing around it. False when the caret has moved
   * off the brackets since, which is the reader having gone elsewhere and is
   * not a failure worth saying anything about.
   */
  replaceWikiTrigger(target: string, title?: string): boolean {
    const view = this.view;
    if (!view || this.readOnly) return false;
    const { $from, empty } = view.state.selection;
    if (!empty || !$from.parent.isTextblock) return false;
    const before = $from.parent.textBetween(0, $from.parentOffset);
    const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size);
    const range = triggerRange(before, after);
    if (range === null) return false;
    const text = wikiLinkText(target, title);
    const tr = view.state.tr.insertText(text, $from.pos + range.from, $from.pos + range.to);
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }

  /** Paste text at the caret, read as markdown: Paste as Plain Text's half. */
  pasteText(text: string): void {
    const view = this.view;
    if (!view || this.readOnly) return;
    const slice = sliceFromText(text, view.state.selection.$from);
    view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
    view.focus();
  }

  /** The whole document as markdown, which is what a transform plugin reads. */
  getMarkdown(): string {
    const view = this.view;
    if (!view) return '';
    return captureMarkdown({
      doc: view.state.doc,
      origins: getBlockOrigins(view.state),
      document: this.document,
      pristine: this.pristine,
    }).join('\n\n');
  }

  /**
   * Replace the document with new markdown, as one undoable step.
   *
   * Deliberately not a whole-document swap. Replacing everything would discard
   * every block's provenance, so a plugin that reformatted one line would cause
   * the entire file to be re-serialized and byte fidelity would be lost for
   * blocks nobody touched.
   *
   * Instead the unchanged blocks at the start and end are left alone and only
   * the differing middle is replaced. A transform that rewrites one heading
   * therefore touches one block, and the rest of the file still saves byte for
   * byte identical.
   *
   * Returns false when the markdown is already what the document holds.
   */
  replaceMarkdown(markdown: string): boolean {
    const view = this.view;
    if (!view) return false;

    const current = captureMarkdown({
      doc: view.state.doc,
      origins: getBlockOrigins(view.state),
      document: this.document,
      pristine: this.pristine,
    });

    const lf = toLf(markdown);
    // Flagged `@roobli/md` path: incremental reparseFromText when a prior split
    // is cached; full split + reseed after typing invalidation. Micromark
    // stays on splitBlocks unchanged.
    const spans = isRoobliMdEngine()
      ? this.priorSplit.spansForReplace(lf).spans
      : splitBlocks(lf).spans;
    const next = spans.map((span) => toLf(span.markdown));
    if (current.length === next.length && current.every((value, index) => value === next[index])) return false;

    let prefix = 0;
    const shortest = Math.min(current.length, next.length);
    while (prefix < shortest && current[prefix] === next[prefix]) prefix += 1;

    let suffix = 0;
    while (suffix < shortest - prefix
      && current[current.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;

    // Character positions of the replaced range in the ProseMirror document.
    let from = 0;
    for (let index = 0; index < prefix; index += 1) from += view.state.doc.child(index).nodeSize;
    let to = view.state.doc.content.size;
    for (let index = 0; index < suffix; index += 1) {
      to -= view.state.doc.child(view.state.doc.childCount - 1 - index).nodeSize;
    }

    const replacement = spans.slice(prefix, next.length - suffix).map(blockFromSpan);
    const transaction = view.state.tr.replaceWith(from, to, replacement);
    this.replaceInFlight = true;
    try {
      view.dispatch(transaction.scrollIntoView());
    } finally {
      this.replaceInFlight = false;
    }
    return true;
  }

  /**
   * LF buffer held for a full-source save, when Source Mode took the escape.
   *
   * The source view prefers this over a block re-join so a gap-only edit is
   * still what the reader sees if they leave and re-enter before saving.
   */
  get pendingSourceMarkdown(): string | null {
    return this.pendingSource;
  }

  /**
   * Settle Source Code Mode text into the document.
   *
   * Prefers block-wise `replaceMarkdown` so untouched blocks keep provenance.
   * When the buffer's gaps (or leading / extra trailing) differ from the
   * accepted file, keeps the LF buffer for a `mode: 'source'` capture instead
   * of pretending the block model absorbed them. Final-newline-only changes
   * stay on the envelope and never take the escape.
   */
  applySourceBuffer(markdown: string): boolean {
    if (this.readOnly) return false;
    const envelopeChanged = this.setEnvelope({ hasFinalNewline: sourceHasFinalNewline(markdown) });
    const blockReplaced = this.replaceMarkdown(markdown);
    const kind = sourceSettleKind({
      blockReplaced,
      buffer: markdown,
      currentDocumentText: this.document.text,
    });

    if (kind === 'source') {
      const lf = toLf(markdown);
      if (this.pendingSource === lf) return blockReplaced || envelopeChanged;
      this.pendingSource = lf;
      if (!this.dirty) {
        this.dirty = true;
        this.options.onDirtyChange?.(true);
      }
      this.options.onDocumentChanged?.();
      return true;
    }

    if (this.pendingSource !== null) {
      this.pendingSource = null;
      // May have been dirty only for the escape; drop the mark when the
      // document and envelope are back where they started.
      if (this.dirty) {
        const view = this.view;
        const still = this.target !== null
          || (view !== null && !view.state.doc.eq(this.baselineDoc));
        if (!still) {
          this.dirty = false;
          this.options.onDirtyChange?.(false);
        }
      }
    }
    return blockReplaced || envelopeChanged;
  }

  /**
   * Plugin editor ABI. Styling only, so it cannot reach the document.
   */
  setSemanticFocus(enabled: boolean): void {
    if (enabled) this.host.dataset.semanticFocus = 'true';
    else delete this.host.dataset.semanticFocus;
  }

  undo(): void {
    const view = this.view;
    if (view) undo(view.state, view.dispatch);
  }

  redo(): void {
    const view = this.view;
    if (view) redo(view.state, view.dispatch);
  }

  /**
   * Build the transaction describing the current editor contents.
   *
   * Throws rather than returning a partial result, because a save built from a
   * document that is not ready would silently write the wrong bytes.
   */
  capture(): NotoTransaction {
    return this.captureWithStats().transaction;
  }

  captureWithStats(): { transaction: NotoTransaction; stats: CaptureStats } {
    const view = this.view;
    if (!view) throw new Error('EDITOR_NOT_READY: the editor is not mounted');
    if (view.composing) {
      throw new Error('IME_COMPOSITION_ACTIVE: finish the current word before saving');
    }

    if (this.pendingSource !== null) {
      const lineEnding = this.envelope.lineEnding === 'mixed'
        ? this.document.envelope.lineEnding
        : this.envelope.lineEnding;
      return {
        transaction: {
          version: NOTO_MARKDOWN_VERSION,
          mode: 'source',
          documentId: this.document.documentId,
          revisionId: this.document.revisionId,
          expectedSourceSha256: this.document.envelope.sourceSha256,
          sourceBytes: encodeSourceBuffer({
            markdown: this.pendingSource,
            lineEnding,
            bom: this.document.envelope.bom,
          }),
        },
        stats: { reused: 0, serialized: view.state.doc.childCount },
      };
    }

    return captureTransaction({
      doc: view.state.doc,
      origins: getBlockOrigins(view.state),
      document: this.document,
      pristine: this.pristine,
      envelope: this.target ?? undefined,
    });
  }

  /**
   * Adopt a newly saved document as the clean baseline.
   *
   * The editor keeps the user's current content and undo history; only the
   * provenance is re-pointed, so a save never interrupts typing.
   */
  commit(document: NotoDocumentWire): void {
    const view = this.view;
    if (!view) return;

    this.document = document;
    this.pendingSource = null;
    /*
     * Clear the pending change only when this document is what it asked for.
     *
     * A save takes a moment, and a reader can choose a different ending while
     * one is in flight. Clearing unconditionally threw that choice away as the
     * older save landed, so the second choice appeared to do nothing at all.
     */
    if (this.target
      && this.target.hasFinalNewline === document.envelope.hasFinalNewline
      && (this.target.lineEnding === 'mixed' || this.target.lineEnding === document.envelope.lineEnding)) {
      this.target = null;
    }
    // Slice the block text out of the accepted document rather than parsing it
    // again. Main already worked out where every block sits and sent the
    // offsets, so a save no longer costs a full parse in the renderer too.
    this.pristine = new Map();
    view.state.doc.forEach((node, _offset, index) => {
      const origin = document.origins[index];
      const span = document.spans[index];
      if (!origin || !span) return;
      this.pristine.set(origin.blockId, {
        node,
        markdown: toLf(document.text.slice(span.start, span.end)),
      });
    });

    this.baselineDoc = view.state.doc;
    view.dispatch(rebaseOrigins(view.state.tr, document.origins));

    // A change to the file's endings that this save did not carry is still
    // waiting, so the document is not clean and the reader still has something
    // to save. Clearing regardless threw away a choice made while the save was
    // in flight, and took the Save button away with it.
    if (this.dirty && this.target === null) {
      this.dirty = false;
      this.options.onDirtyChange?.(false);
    }
  }

  /**
   * Replace the whole document, for example after an external file change.
   *
   * Parses off the UI thread the same way open does, then swaps the editor
   * state in one step once the spans are ready.
   */
  async reload(document: NotoDocumentWire): Promise<void> {
    const view = this.view;
    if (!view) return;
    const spans = blockSpansFromWire(document) ?? await parseDocumentSpans(document.text);
    // A newer reload or a teardown may have landed while the worker ran.
    if (this.view !== view) return;
    this.document = document;
    this.pendingSource = null;
    const doc = this.buildDoc(document, spans);
    this.baselineDoc = doc;
    view.updateState(EditorState.create({ doc, plugins: this.plugins(document) }));
    if (this.dirty) {
      this.dirty = false;
      this.options.onDirtyChange?.(false);
    }
  }

  destroy(): void {
    if (this.countTimer !== null) clearTimeout(this.countTimer);
    this.countTimer = null;
    this.view?.destroy();
    this.view = null;
    this.pristine = new Map();
    this.priorSplit.invalidate();
  }
}

export { notoSchema };
