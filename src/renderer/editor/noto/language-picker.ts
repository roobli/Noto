/**
 * The list a code fence's language is chosen from.
 *
 * It opens under the fence's language label with a search field and the
 * languages as rows, filtered as the reader types: by a language's name, its
 * id or any of the names people type for it, the letters that matched marked.
 * Arrows move, Enter or Tab chooses, Escape leaves. A name the list does not
 * know can still be used as written, since a fence may name anything.
 *
 * With nothing typed, the list starts with what the fence already says and,
 * when the fence says nothing, with what the code was read as: one press of
 * Enter keeps the guess.
 *
 * It is drawn outside the editor, on the page, so a fence's clipped corner
 * never cuts it, and only one is open at a time.
 */

import { isComposing } from '../../ime';
import { LANGUAGES, languageEntry, suggestLanguages, type LanguageEntry } from './languages';

export interface LanguagePickerOptions {
  /** What the fence says now, empty when nothing. */
  readonly current: string;
  /** What the code reads as when the fence says nothing. */
  readonly guess: string | null;
  /** The reader chose `lang`, empty for "say nothing and keep guessing". */
  readonly onPick: (lang: string) => void;
  /** The list is gone; `returnFocus` when the keys should go back to the note. */
  readonly onClose: (returnFocus: boolean) => void;
}

interface Row {
  /** What choosing it writes. */
  readonly lang: string;
  readonly name: string;
  /** Beside the name, quieter: an id, a matched alias, or a word about the row. */
  readonly detail: string;
  readonly nameMarks: readonly number[];
  readonly detailMarks: readonly number[];
}

/** Room the list wants under its label before it opens above instead. */
const ROOM_BELOW = 280;

let open: LanguagePicker | null = null;

/** Close whichever list is open, as if the reader had pressed elsewhere. */
export function closeLanguagePicker(): void {
  open?.close(false);
}

export class LanguagePicker {
  private readonly root: HTMLElement;
  private readonly field: HTMLInputElement;
  private readonly list: HTMLElement;
  private rows: Row[] = [];
  private active = 0;
  private closed = false;
  private frame: number | null = null;

  static show(anchor: HTMLElement, options: LanguagePickerOptions): LanguagePicker {
    open?.close(false);
    open = new LanguagePicker(anchor, options);
    return open;
  }

  private constructor(private readonly anchor: HTMLElement, private readonly options: LanguagePickerOptions) {
    this.root = document.createElement('div');
    this.root.className = 'noto-lang-picker';
    this.root.dataset.testid = 'language-picker';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Code block language');

    this.field = document.createElement('input');
    this.field.className = 'noto-lang-picker-field';
    this.field.type = 'text';
    this.field.placeholder = 'Search languages';
    this.field.spellcheck = false;
    this.field.autocomplete = 'off';
    this.field.setAttribute('role', 'combobox');
    this.field.setAttribute('aria-expanded', 'true');
    this.field.setAttribute('aria-autocomplete', 'list');
    this.field.setAttribute('aria-controls', 'noto-lang-picker-list');

    this.list = document.createElement('div');
    this.list.className = 'noto-lang-picker-list';
    this.list.id = 'noto-lang-picker-list';
    this.list.setAttribute('role', 'listbox');

    this.root.append(this.field, this.list);
    document.body.append(this.root);

    this.field.addEventListener('input', this.refresh);
    this.field.addEventListener('keydown', this.onKey);
    this.field.addEventListener('blur', this.onBlur);
    // A press on a row must not take the keys from the field; the click chooses.
    this.list.addEventListener('mousedown', (event) => event.preventDefault());
    this.list.addEventListener('click', this.onClick);
    this.list.addEventListener('pointermove', this.onHover);
    document.addEventListener('pointerdown', this.onPressOutside, true);
    window.addEventListener('resize', this.schedulePlace);
    document.addEventListener('scroll', this.schedulePlace, true);

    this.refresh();
    this.place();
    this.field.focus();
  }

  close(returnFocus: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (open === this) open = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    document.removeEventListener('pointerdown', this.onPressOutside, true);
    window.removeEventListener('resize', this.schedulePlace);
    document.removeEventListener('scroll', this.schedulePlace, true);
    this.field.removeEventListener('blur', this.onBlur);
    this.root.remove();
    this.options.onClose(returnFocus);
  }

  private choose(row: Row | undefined): void {
    if (!row) return;
    this.options.onPick(row.lang);
    this.close(true);
  }

  /** The rows for what is typed now. */
  private readonly refresh = (): void => {
    const query = this.field.value.trim();
    this.rows = query ? this.matching(query) : this.starting();
    this.active = 0;
    this.draw();
  };

  /** Nothing typed: what the fence says, what it reads as, then every language by how common it is. */
  private starting(): Row[] {
    const { current, guess } = this.options;
    const currentEntry = current ? languageEntry(current) : null;
    const guessEntry = guess ? languageEntry(guess) : null;
    const rows: Row[] = [];
    const seen = new Set<LanguageEntry>();
    const add = (entry: LanguageEntry, detail: string) => {
      if (seen.has(entry)) return;
      seen.add(entry);
      rows.push({ lang: entry.id, name: entry.name, detail, nameMarks: [], detailMarks: [] });
    };
    if (current) {
      if (currentEntry) add(currentEntry, current);
      else rows.push({ lang: current, name: current, detail: 'as written', nameMarks: [], detailMarks: [] });
    } else if (guessEntry) {
      add(guessEntry, 'detected');
    }
    // Back to saying nothing, and letting the code be read again.
    if (current) {
      rows.push({
        lang: '',
        name: 'Detect automatically',
        detail: guessEntry ? guessEntry.id : '',
        nameMarks: [],
        detailMarks: [],
      });
    }
    for (const entry of LANGUAGES) add(entry, entry.id);
    return rows;
  }

  private matching(query: string): Row[] {
    const rows: Row[] = suggestLanguages(query).map((suggestion) => ({
      // The name the row shows is the name written: `ts` typed and chosen is
      // `ts` in the fence, as the reader wrote it.
      lang: suggestion.onName ? suggestion.entry.id : suggestion.matched,
      name: suggestion.entry.name,
      detail: suggestion.onName ? suggestion.entry.id : suggestion.matched,
      nameMarks: suggestion.onName ? suggestion.marks : [],
      detailMarks: suggestion.onName ? [] : suggestion.marks,
    }));
    const typed = query.toLowerCase();
    // A name the list does not know is still a name a fence can carry.
    if (!languageEntry(typed) && /^[\w+#.-]+$/.test(typed)) {
      rows.push({ lang: typed, name: `Use "${typed}"`, detail: 'as written', nameMarks: [], detailMarks: [] });
    }
    return rows;
  }

  private draw(): void {
    const { current } = this.options;
    const chosen = current ? languageEntry(current)?.id ?? current : '';
    this.list.replaceChildren(...this.rows.map((row, index) => {
      const option = document.createElement('div');
      option.className = 'noto-lang-option';
      option.id = `noto-lang-option-${index}`;
      option.dataset.index = String(index);
      option.dataset.lang = row.lang;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === this.active));
      const rowId = row.lang ? languageEntry(row.lang)?.id ?? row.lang : '';
      if (rowId === chosen && (rowId !== '' || current === '')) option.dataset.current = '';
      const name = document.createElement('span');
      name.className = 'noto-lang-option-name';
      name.append(...marked(row.name, row.nameMarks));
      const detail = document.createElement('span');
      detail.className = 'noto-lang-option-detail';
      detail.append(...marked(row.detail, row.detailMarks));
      option.append(name, detail);
      return option;
    }));
    if (this.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'noto-lang-picker-empty';
      empty.textContent = 'No language by that name';
      this.list.append(empty);
    }
    this.showActive();
  }

  private showActive(): void {
    const options = this.list.querySelectorAll<HTMLElement>('.noto-lang-option');
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === this.active)));
    const row = options[this.active];
    if (row) {
      this.field.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    } else {
      this.field.removeAttribute('aria-activedescendant');
    }
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (isComposing(event)) return;
    const count = this.rows.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count === 0) return;
      this.active = (this.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      this.showActive();
    } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey && count > 0)) {
      event.preventDefault();
      this.choose(this.rows[this.active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    }
  };

  private readonly onHover = (event: PointerEvent): void => {
    const option = (event.target as Element).closest<HTMLElement>('.noto-lang-option');
    const index = option ? Number(option.dataset.index) : -1;
    if (index >= 0 && index !== this.active) {
      this.active = index;
      this.list.querySelectorAll('.noto-lang-option')
        .forEach((row, at) => row.setAttribute('aria-selected', String(at === index)));
    }
  };

  private readonly onClick = (event: MouseEvent): void => {
    const option = (event.target as Element).closest<HTMLElement>('.noto-lang-option');
    if (option) this.choose(this.rows[Number(option.dataset.index)]);
  };

  get isOpen(): boolean {
    return !this.closed;
  }

  private readonly onPressOutside = (event: PointerEvent): void => {
    const target = event.target as Node;
    // The label that opened it toggles it, on its own click.
    if (this.root.contains(target) || this.anchor.contains(target)) return;
    this.close(false);
  };

  // The window losing focus, or the keys going anywhere but a row.
  private readonly onBlur = (): void => {
    queueMicrotask(() => {
      if (!this.closed && document.activeElement !== this.field) this.close(false);
    });
  };

  private readonly schedulePlace = (): void => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.place();
    });
  };

  /** Under the label, right edges in line; above it when the window has no room below. */
  private place(): void {
    if (!this.anchor.isConnected) {
      this.close(false);
      return;
    }
    const box = this.anchor.getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) {
      this.close(false);
      return;
    }
    const style = this.root.style;
    style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
    const below = window.innerHeight - box.bottom;
    if (below >= ROOM_BELOW || below >= box.top) {
      style.top = `${box.bottom + 4}px`;
      style.bottom = '';
      style.maxHeight = `${Math.max(120, below - 16)}px`;
      this.root.dataset.side = 'below';
    } else {
      style.top = '';
      style.bottom = `${window.innerHeight - box.top + 4}px`;
      style.maxHeight = `${Math.max(120, box.top - 16)}px`;
      this.root.dataset.side = 'above';
    }
  }
}

/** Text with the characters at `marks` in `<mark>`. */
function marked(text: string, marks: readonly number[]): Node[] {
  if (marks.length === 0) return [document.createTextNode(text)];
  const set = new Set(marks);
  const nodes: Node[] = [];
  let run = '';
  let inMark = false;
  const flush = () => {
    if (!run) return;
    if (inMark) {
      const mark = document.createElement('mark');
      mark.textContent = run;
      nodes.push(mark);
    } else {
      nodes.push(document.createTextNode(run));
    }
    run = '';
  };
  [...text].forEach((character, index) => {
    const wanted = set.has(index);
    if (wanted !== inMark) {
      flush();
      inMark = wanted;
    }
    run += character;
  });
  flush();
  return nodes;
}
