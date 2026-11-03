import { describe, expect, it } from 'vitest';
import { safeStyle, verdictFor } from '../../src/renderer/editor/noto/html-sanitize';

// The walk itself needs a real DOM and is driven in the packaged tests; what
// decides its outcome is pure and is decided here.

describe('what happens to an element', () => {
  it('keeps the ones a note draws with', () => {
    for (const tag of ['table', 'td', 'details', 'summary', 'div', 'span', 'img', 'font', 'center']) {
      expect(verdictFor(tag)).toBe('keep');
    }
  });

  it('drops the ones that could act, whole', () => {
    for (const tag of ['script', 'iframe', 'object', 'form', 'input', 'link', 'meta', 'svg', 'video']) {
      expect(verdictFor(tag)).toBe('drop');
    }
  });

  it('unwraps one it does not know, so the words inside are not lost', () => {
    expect(verdictFor('article')).toBe('unwrap');
    expect(verdictFor('custom-element')).toBe('unwrap');
  });
});

describe('the style a note may set', () => {
  it('keeps colour, weight and the lengths', () => {
    expect(safeStyle('color: red; font-weight: 600')).toBe('color: red; font-weight: 600');
    expect(safeStyle('background-color: rgb(255, 240, 200)')).toBe('background-color: rgb(255, 240, 200)');
    expect(safeStyle('text-align: center; width: 60%')).toBe('text-align: center; width: 60%');
    expect(safeStyle('zoom: 50%')).toBe('zoom: 50%');
  });

  it('drops anything that could fetch, act, or leave its block', () => {
    expect(safeStyle('background: url(https://example.com/a.png)')).toBe('');
    expect(safeStyle('width: expression(alert(1))')).toBe('');
    expect(safeStyle('background: -moz-binding: url(x)')).toBe('');
    // Pinned to the window rather than placed in its block: dropped, and an
    // offset left without it places nothing.
    expect(safeStyle('position: fixed; top: 0')).toBe('top: 0');
    expect(safeStyle('position: sticky')).toBe('');
    expect(safeStyle('font-family: "a\\"; position: fixed')).toBe('');
  });

  it('allows only the few displays that cannot rearrange the page', () => {
    expect(safeStyle('display: flex')).toBe('display: flex');
    expect(safeStyle('display: none')).toBe('display: none');
    expect(safeStyle('display: contents')).toBe('');
  });

  it('keeps what it knows out of a declaration that also holds what it does not', () => {
    expect(safeStyle('color: green; z-index: 9; font-size: 14px'))
      .toBe('color: green; font-size: 14px');
    // A value longer than any real one is a paste, not a style.
    expect(safeStyle(`color: ${'a'.repeat(200)}`)).toBe('');
  });
});

describe('placing and scaling, which a note uses to show a wide page smaller', () => {
  it('keeps a position relative to the block, and scaling or moving, and nothing else', () => {
    expect(safeStyle('position: relative; overflow: hidden')).toBe('position: relative; overflow: hidden');
    expect(safeStyle('position: absolute; left: -480px; top: -310px')).toBe('position: absolute; left: -480px; top: -310px');
    expect(safeStyle('transform: scale(0.4)')).toBe('transform: scale(0.4)');
    expect(safeStyle('transform: translate(-10px, 4%) scale(0.5)')).toBe('transform: translate(-10px, 4%) scale(0.5)');
    expect(safeStyle('transform: rotate(45deg)')).toBe('');
    expect(safeStyle('transform: matrix(1, 0, 0, 1, 0, 0)')).toBe('');
    expect(safeStyle('overflow: overlay')).toBe('');
  });
});
