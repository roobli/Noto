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
      return typeof record.serial === 'number' && typeof record.message === 'string';
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
  private ready = false;
  private source: string | null = null;
  private serial = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onEnter: () => void) {
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

    this.dom.append(this.frame, this.status);
    this.dom.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.onEnter();
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
      this.serial += 1;
      this.frame.style.height = '0px';
      this.dom.dataset.state = 'failed';
      this.status.textContent = `The diagram could not be drawn: ${mermaid.error}`;
      return;
    }
    if (mermaid.source === this.source) return;
    this.source = mermaid.source;
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
    } else {
      this.frame.style.height = '0px';
      this.dom.dataset.state = 'failed';
      this.status.textContent = `The diagram could not be drawn: ${data.message}`;
    }
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    const target = this.frame.contentWindow;
    if (target) frames.delete(target);
    this.dom.remove();
  }

  private post(): void {
    const target = this.frame.contentWindow;
    if (!this.ready || !target || this.source === null) return;
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
