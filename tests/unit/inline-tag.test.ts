import { describe, expect, it } from 'vitest';
import { closingTag, isInlineComment, openingTag } from '../../src/renderer/editor/noto/inline-tag';

describe('reading an inline tag a note writes', () => {
  it('reads bare formatting tags, and refuses one that carries attributes it does not know', () => {
    expect(openingTag('<kbd>')).toEqual({ name: 'kbd', style: '', title: null, anchor: null });
    expect(openingTag('<q>')?.name).toBe('q');
    expect(openingTag('<kbd class="x">')).toBeNull();
    expect(openingTag('<div>')).toBeNull();
  });

  it('keeps colour, fill and size from a style, and nothing that could place or load', () => {
    expect(openingTag('<span style="color:red">')?.style).toBe('--note-color: red');
    expect(openingTag('<span style="background:#fff3a0; font-size: 18px">')?.style).toBe('--note-fill: #fff3a0; --note-size: 18px');
    expect(openingTag('<span style="position:fixed; top:0; color: url(x)">')?.style).toBe('');
    expect(openingTag("<span style='color: expression(alert(1))'>")?.style).toBe('');
    expect(openingTag('<span style="color: red; background-image: url(https://e.com/x.png)">')?.style).toBe('--note-color: red');
  });

  it('reads the old font tag, its size as browsers size it', () => {
    expect(openingTag('<font color=green size=4>')?.style).toBe('--note-color: green; --note-size: 1.125em');
    expect(openingTag('<font color="javascript:x" size=9>')?.style).toBe('');
  });

  it('leaves a span with a class to whoever owns the class, and reads an abbr title', () => {
    expect(openingTag('<span class="sidenote">')).toBeNull();
    expect(openingTag('<abbr title="HyperText Markup Language">')?.title).toBe('HyperText Markup Language');
  });

  it('reads an anchor, but leaves a link with an address to markdown', () => {
    expect(openingTag('<a id="here">')?.anchor).toBe('here');
    expect(openingTag('<span id="jump">')?.anchor).toBe('jump');
    expect(openingTag('<a href="https://e.com">')).toBeNull();
  });

  it('names closing tags and comments', () => {
    expect(closingTag('</span>')).toBe('span');
    expect(closingTag('<span>')).toBeNull();
    expect(isInlineComment('<!-- note -->')).toBe(true);
    expect(isInlineComment('<b>')).toBe(false);
  });
});
