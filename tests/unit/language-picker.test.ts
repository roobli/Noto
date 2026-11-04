// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguagePicker, closeLanguagePicker } from '../../src/renderer/editor/noto/language-picker';

function open(current: string, guess: string | null = null) {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const onPick = vi.fn();
  const onClose = vi.fn();
  LanguagePicker.show(anchor, { current, guess, onPick, onClose });
  const root = document.querySelector<HTMLElement>('[data-testid="language-picker"]')!;
  const field = root.querySelector<HTMLInputElement>('.noto-lang-picker-field')!;
  const key = (name: string) => field.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  const type = (text: string) => { field.value = text; field.dispatchEvent(new Event('input')); };
  const active = () => root.querySelector<HTMLElement>('.noto-lang-option[aria-selected="true"]');
  return { root, field, key, type, active, onPick, onClose };
}

afterEach(() => {
  closeLanguagePicker();
  document.body.replaceChildren();
});

describe('the language list', () => {
  it('keeps what the fence says, as it says it, on Enter', () => {
    const picker = open('ts');
    expect(picker.active()?.dataset.lang).toBe('ts');
    expect(picker.active()?.getAttribute('aria-label')).toBe('TypeScript, current');
    picker.key('Enter');
    expect(picker.onPick).toHaveBeenCalledWith('ts');
    expect(picker.onClose).toHaveBeenCalledWith(true);
  });

  it('starts with the guess when the fence says nothing, and offers to stop guessing when it does', () => {
    expect(open('', 'python').active()?.dataset.lang).toBe('python');
    closeLanguagePicker();
    const named = open('go', 'python');
    expect([...named.root.querySelectorAll<HTMLElement>('.noto-lang-option')].slice(0, 2).map((row) => row.dataset.lang))
      .toEqual(['go', '']);
  });

  it("writes the name typed when it is one of a language's names, and any name as written", () => {
    const typed = open('');
    typed.type('py');
    typed.key('Tab');
    expect(typed.onPick).toHaveBeenCalledWith('py');
    const custom = open('');
    custom.type('pkl');
    const rows = [...custom.root.querySelectorAll<HTMLElement>('.noto-lang-option')];
    expect(rows.at(-1)?.dataset.lang).toBe('pkl');
  });

  it('closes on Escape without a choice, and keeps the row the arrows chose under a still pointer', () => {
    const picker = open('');
    picker.type('ja');
    picker.key('ArrowDown');
    const chosen = picker.active()?.dataset.lang;
    const list = picker.root.querySelector('.noto-lang-picker-list')!;
    const first = list.querySelector('.noto-lang-option')!;
    first.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(picker.active()?.dataset.lang).not.toBe(chosen);
    picker.key('ArrowDown');
    const again = picker.active()?.dataset.lang;
    // A move event at the same place, as Chromium sends after a scroll, changes nothing.
    first.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(picker.active()?.dataset.lang).toBe(again);
    picker.key('Escape');
    expect(picker.onPick).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="language-picker"]')).toBeNull();
  });
});
