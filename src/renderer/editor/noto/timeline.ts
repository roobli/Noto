/**
 * A `timeline` fence drawn as a vertical chronology.
 *
 * The author's Typora `timeline` plugin extends a fenced code block whose
 * language is `timeline`. The file keeps ordinary markdown — `#` title,
 * `##` time, then paragraphs, lists, tasks, quotes and rules — so a note
 * opened without the drawing still reads. Pure, so the parse and the HTML
 * are tested without a document.
 */

/** Language name the author's plugin registers. */
export const TIMELINE_LANGUAGE = 'timeline';

/** Default body an Insert Timeline command leaves for the reader to fill. */
export const TIMELINE_TEMPLATE = [
  '# Timeline',
  '## 2024',
  'Something that happened.',
  '## 2025',
  'Something that followed.',
].join('\n');

export function isTimelineLanguage(lang: string): boolean {
  return lang.trim().toLowerCase() === TIMELINE_LANGUAGE;
}

/** One piece of content under a time bucket. */
export type TimelineItem =
  | { readonly type: 'p' | 'blockquote' | 'h3' | 'h4' | 'h5' | 'h6'; readonly value: string }
  | { readonly type: 'hr' }
  | { readonly type: 'task'; readonly checked: boolean; readonly value: string }
  | { readonly type: 'ul' | 'ol'; readonly list: readonly string[] };

/** One dated (or labelled) stop on the line. */
export interface TimelineBucket {
  readonly time: string;
  readonly items: readonly TimelineItem[];
}

/** The whole fence, after a successful parse. */
export interface TimelineData {
  readonly title: string;
  readonly buckets: readonly TimelineBucket[];
}

export type TimelineParseResult =
  | { readonly ok: true; readonly data: TimelineData }
  | { readonly ok: false; readonly line: number; readonly reason: string };

const HEADING = /^(#{3,6})\s+(.+?)$/;
const TASK = /^[-+*]\s+\[([xX ])\]\s+(.*)$/;
const UL = /^[-*]\s+(.+)$/;
const OL = /^\d+\.\s+(.+)$/;
const QUOTE = /^>\s?(.*)$/;
const HR = /^(\*\*\*|---)$/;

/**
 * Parse a fence body the way the Typora plugin does.
 *
 * `#` is the optional title and must come first. Each `##` opens a time
 * bucket; everything after it until the next `##` is content for that stop.
 * A body before any time is refused rather than guessed into the wrong place.
 */
export function parseTimeline(source: string): TimelineParseResult {
  let titleText = '';
  const buckets: Array<{ time: string; items: TimelineItem[] }> = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const lineNum = i + 1;

    if (line.startsWith('# ')) {
      if (titleText !== '') {
        return { ok: false, line: lineNum, reason: 'A timeline may have only one title.' };
      }
      if (buckets.length > 0) {
        return { ok: false, line: lineNum, reason: 'The title must come before any time.' };
      }
      titleText = line.slice(2).trim();
      continue;
    }

    if (line.startsWith('## ')) {
      buckets.push({ time: line.slice(3).trim(), items: [] });
      continue;
    }

    if (buckets.length === 0) {
      return { ok: false, line: lineNum, reason: 'Content needs a time (`## …`) above it.' };
    }

    const current = buckets[buckets.length - 1]!;
    const last = current.items[current.items.length - 1];

    if (HR.test(line)) {
      current.items.push({ type: 'hr' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length as 3 | 4 | 5 | 6;
      current.items.push({ type: `h${level}`, value: heading[2]!.trim() });
      continue;
    }

    const task = TASK.exec(line);
    if (task) {
      current.items.push({
        type: 'task',
        checked: task[1]!.toLowerCase() === 'x',
        value: task[2]!,
      });
      continue;
    }

    const ul = UL.exec(line);
    if (ul) {
      if (last && last.type === 'ul') {
        current.items[current.items.length - 1] = {
          type: 'ul',
          list: [...last.list, ul[1]!],
        };
      } else {
        current.items.push({ type: 'ul', list: [ul[1]!] });
      }
      continue;
    }

    const ol = OL.exec(line);
    if (ol) {
      if (last && last.type === 'ol') {
        current.items[current.items.length - 1] = {
          type: 'ol',
          list: [...last.list, ol[1]!],
        };
      } else {
        current.items.push({ type: 'ol', list: [ol[1]!] });
      }
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      current.items.push({ type: 'blockquote', value: quote[1]! });
      continue;
    }

    current.items.push({ type: 'p', value: line });
  }

  return { ok: true, data: { title: titleText, buckets } };
}

/** Escape text that becomes HTML text content. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A light inline pass for timeline event text.
 *
 * Enough for the vault's usual marks — bold, italic, code, a link — without
 * pulling the whole markdown pipeline into a fence preview. Unknown markup
 * stays escaped as text.
 */
export function inlineToHtml(text: string): string {
  const parts: string[] = [];
  const withCode = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const token = `\u0000${parts.length}\u0000`;
    parts.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  let html = escapeHtml(withCode);
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, label: string, href: string) =>
    `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${label}</a>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  return html.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => parts[Number(index)] ?? '');
}

function itemHtml(item: TimelineItem): string {
  switch (item.type) {
    case 'hr':
      return '<hr>';
    case 'task': {
      const checked = item.checked ? ' checked' : '';
      return `<p class="noto-timeline-task"><input type="checkbox" disabled${checked}><span>${inlineToHtml(item.value)}</span></p>`;
    }
    case 'ul':
    case 'ol': {
      const lis = item.list.map((li) => `<li>${inlineToHtml(li)}</li>`).join('');
      return `<${item.type}>${lis}</${item.type}>`;
    }
    case 'p':
    case 'blockquote':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `<${item.type}>${inlineToHtml(item.value)}</${item.type}>`;
    default:
      return '';
  }
}

/** The HTML a successful parse draws. */
/**
 * The HTML a successful parse draws: an ordered list of stops, each with its
 * own dot and the length of rail that runs down to the next, so the rail is
 * one unbroken line through the dots however tall a stop's content is. The
 * last stop's rail fades out rather than ending in a stub.
 */
export function timelineHtml(data: TimelineData): string {
  const buckets = data.buckets.map((bucket, index) => {
    const items = bucket.items.map(itemHtml).join('');
    const last = index === data.buckets.length - 1 ? ' is-last' : '';
    return [
      `<li class="noto-timeline-stop${last}">`,
      '<span class="noto-timeline-rail" aria-hidden="true"><span class="noto-timeline-dot"></span></span>',
      `<div class="noto-timeline-time">${escapeHtml(bucket.time)}</div>`,
      items ? `<div class="noto-timeline-event">${items}</div>` : '',
      '</li>',
    ].join('');
  }).join('');

  const title = data.title
    ? `<div class="noto-timeline-title">${escapeHtml(data.title)}</div>`
    : '';
  return `<div class="noto-timeline">${title}<ol class="noto-timeline-stops">${buckets}</ol></div>`;
}

/**
 * A timeline drawn beside its fence source.
 *
 * Lives in the editor page (not an iframe): the HTML is ours and escaped.
 * A press on the drawing puts the caret in the source, as a mermaid
 * diagram does.
 */
export class TimelineFrame {
  readonly dom: HTMLElement;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private source: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onEnter: () => void) {
    this.dom = document.createElement('div');
    this.dom.className = 'noto-timeline-frame';
    this.dom.contentEditable = 'false';
    this.dom.dataset.state = 'loading';

    this.body = document.createElement('div');
    this.body.className = 'noto-timeline-body';

    this.status = document.createElement('div');
    this.status.className = 'noto-timeline-status';
    this.status.setAttribute('role', 'status');

    this.dom.append(this.body, this.status);
    this.dom.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.onEnter();
    });
  }

  /** Draw this source once typing pauses. */
  render(source: string): void {
    if (source === this.source) return;
    this.source = source;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.paint();
    }, 150);
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.dom.remove();
  }

  private paint(): void {
    if (this.source === null) return;
    const parsed = parseTimeline(this.source);
    if (!parsed.ok) {
      this.body.innerHTML = '';
      this.dom.dataset.state = 'failed';
      this.status.textContent = `Line ${parsed.line}: ${parsed.reason}`;
      return;
    }
    this.body.innerHTML = timelineHtml(parsed.data);
    this.status.textContent = '';
    this.dom.dataset.state = 'rendered';
  }
}
