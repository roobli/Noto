/**
 * A diagram, drawn in a frame beside the fence that holds its source.
 *
 * The drawing happens in `diagram.html`, a page sandboxed to nothing: no
 * origin, no bridge to main, no way to reach this page. This side posts the
 * fence's text and the current palette in, and reads a height or an error
 * back. The frame takes no pointer events, so a press on the drawing is a
 * press on the fence, which puts the caret in the source the way Typora
 * does. Nothing here touches the document: the fence keeps its text and the
 * file keeps its bytes.
 */

import { diagramDialect, toMermaid } from '../../diagram/legacy-diagrams';
import type { DiagramPalette, DiagramReply, DiagramRequest } from '../../diagram/protocol';

/** Typing pauses this long before the drawing is asked for again. */
const REDRAW_DELAY_MS = 150;
/** No drawing is taller than this; a runaway diagram must not take the page. */
const MAX_HEIGHT_PX = 4000;
/** A drawing that failed while its page was hidden is tried again this many times, once shown. */
const HIDDEN_RETRIES = 2;

const frames = new Map<Window, DiagramFrame>();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('message', (event) => {
    const source = event.source as Window | null;
    if (!source) return;
    frames.get(source)?.receive(event.data);
  });
  // The palette is sent with every request, so a theme change is a redraw.
  new MutationObserver(() => {
    for (const frame of frames.values()) frame.redraw();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function isReply(data: unknown): data is DiagramReply {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  switch (record.type) {
    case 'noto-diagram-ready':
      return true;
    case 'noto-diagram-rendered':
      return typeof record.serial === 'number' && typeof record.height === 'number' && typeof record.width === 'number';
    case 'noto-diagram-failed':
      return typeof record.serial === 'number'
        && typeof record.message === 'string'
        && (record.detail === undefined || typeof record.detail === 'string')
        && (record.line === undefined || (typeof record.line === 'number' && Number.isFinite(record.line)));
    default:
      return false;
  }
}

/** The palette as it stands, read from the tokens so a theme file is honoured. */
export function paletteNow(): DiagramPalette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    paper: read('--paper'),
    raised: read('--raised'),
    ink: read('--ink'),
    inkStrong: read('--ink-strong'),
    muted: read('--muted'),
    hairline: read('--hairline'),
    lineStrong: read('--line-strong'),
    accent: read('--accent'),
    series: Array.from({ length: 8 }, (_, at) => read(`--chart-${at + 1}`)).filter((colour) => colour.length > 0),
  };
}

/** Mermaid, and Typora's `flow` and `sequence`, which are drawn as mermaid. */
export function isDiagramLanguage(lang: string): boolean {
  return diagramDialect(lang) !== null;
}

export class DiagramFrame {
  readonly dom: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private readonly status: HTMLElement;
  private readonly detail: HTMLPreElement;
  private ready = false;
  private source: string | null = null;
  private injectedExtraLines = 0;
  private failedLine: number | null = null;
  private serial = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A drawing waiting for the diagram to be shown.
   *
   * Every note keeps its own page, and the one behind another is hidden.
   * Mermaid measures each box and label as it lays a chart out, and in a
   * hidden page every measure is zero: a chart with labelled arrows failed
   * with "Could not find a suitable point for the given distance", and the
   * failure stayed when the note came forward, since nothing asked again.
   * So nothing is drawn while hidden, and what was asked for then is drawn
   * when the diagram is shown.
   */
  private waitingToBeShown = false;
  /** Whether the diagram was hidden at any moment since the drawing in flight was asked for. */
  private hiddenSincePost = false;
  private hiddenRetries = 0;
  private readonly shown: ResizeObserver | null;

  constructor(private readonly onEnter: (zeroBasedLine?: number) => void) {
    install();
    this.dom = document.createElement('div');
    this.dom.className = 'noto-diagram';
    this.dom.contentEditable = 'false';
    this.dom.dataset.state = 'loading';

    this.frame = document.createElement('iframe');
    this.frame.className = 'noto-diagram-frame';
    this.frame.title = 'Diagram';
    this.frame.tabIndex = -1;
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.src = new URL('diagram.html', window.location.href).toString();
    // The frame's window exists once it is in the document, and its script
    // is listening by the time it has loaded.
    this.frame.addEventListener('load', () => {
      const target = this.frame.contentWindow;
      if (!target) return;
      frames.set(target, this);
      this.ready = true;
      this.post();
    });

    this.status = document.createElement('div');
    this.status.className = 'noto-diagram-status';
    this.status.setAttribute('role', 'status');

    this.detail = document.createElement('pre');
    this.detail.className = 'noto-diagram-detail';

    this.dom.append(this.frame, this.status, this.detail);
    // A hidden page lays the diagram out at no size, and showing it again
    // gives it one: that is the moment to draw what waited.
    this.shown = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        if (!this.isShown()) {
          this.hiddenSincePost = true;
          return;
        }
        if (this.waitingToBeShown) this.post();
      })
      : null;
    this.shown?.observe(this.dom);
    this.dom.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.onEnter(this.failedLine !== null ? Math.max(0, this.failedLine - 1) : undefined);
    });
  }

  /**
   * Draw this fence, once typing pauses. A `flow` or `sequence` fence is
   * rewritten as mermaid first; one that cannot be read says which line, the
   * way a mermaid fence that does not parse does.
   */
  render(source: string, lang = 'mermaid'): void {
    const mermaid = toMermaid(diagramDialect(lang) ?? 'mermaid', source);
    if ('error' in mermaid) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.source = null;
      const hit = /\bline\s+(\d+)\b/i.exec(mermaid.error);
      this.failedLine = hit ? Number(hit[1]) : null;
      this.serial += 1;
      this.frame.style.height = '0px';
      this.dom.dataset.state = 'failed';
      this.status.textContent = `The diagram could not be drawn: ${mermaid.error}`;
      this.detail.textContent = '';
      return;
    }
    if (mermaid.source === this.source) return;
    this.source = mermaid.source;
    this.injectedExtraLines = Math.max(0, mermaid.source.split('\n').length - source.split('\n').length);
    this.hiddenRetries = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.post();
    }, REDRAW_DELAY_MS);
  }

  redraw(): void {
    this.post();
  }

  receive(data: unknown): void {
    if (!isReply(data) || data.type === 'noto-diagram-ready') return;
    if (data.serial !== this.serial) return;
    if (data.type === 'noto-diagram-rendered') {
      this.frame.style.height = `${Math.min(Math.max(0, data.height), MAX_HEIGHT_PX)}px`;
      this.dom.dataset.state = 'rendered';
      this.status.textContent = '';
      this.detail.textContent = '';
      this.failedLine = null;
      this.hiddenRetries = 0;
    } else if ((this.hiddenSincePost || !this.isShown()) && this.hiddenRetries < HIDDEN_RETRIES) {
      // Laid out while hidden, so measured at nothing: not the chart's fault.
      // Drawn again once shown, and the failure is not put up meanwhile.
      this.hiddenRetries += 1;
      this.waitingToBeShown = true;
      if (this.isShown()) this.post();
    } else {
      this.frame.style.height = '0px';
      this.dom.dataset.state = 'failed';
      const userLine = data.line !== undefined ? Math.max(1, data.line - this.injectedExtraLines) : null;
      this.failedLine = userLine;
      const hint = userLine !== null ? ` (click to jump to line ${userLine})` : '';
      this.status.textContent = `The diagram could not be drawn: ${data.message}${hint}`;
      this.detail.textContent = data.detail ?? '';
    }
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.shown?.disconnect();
    const target = this.frame.contentWindow;
    if (target) frames.delete(target);
    this.dom.remove();
  }

  /** Whether the diagram is laid out on the page at all, not in a hidden note. */
  private isShown(): boolean {
    return this.dom.isConnected && this.dom.getClientRects().length > 0;
  }

  private post(): void {
    const target = this.frame.contentWindow;
    if (!this.ready || !target || this.source === null) return;
    if (!this.isShown()) {
      this.waitingToBeShown = true;
      return;
    }
    this.waitingToBeShown = false;
    this.hiddenSincePost = false;
    this.serial += 1;
    const request: DiagramRequest = {
      type: 'noto-diagram-render',
      serial: this.serial,
      source: this.source,
      palette: paletteNow(),
      dark: document.documentElement.dataset.theme === 'dark',
      font: getComputedStyle(this.dom).fontFamily,
    };
    target.postMessage(request, '*');
    if (this.dom.dataset.state !== 'rendered') this.dom.dataset.state = 'rendering';
  }
}
