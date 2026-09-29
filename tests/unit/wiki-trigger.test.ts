import { describe, expect, it } from 'vitest';
import { triggerRange, wikiLinkText } from '../../src/renderer/editor/noto/wiki-trigger';

describe('when typing two brackets asks for a note', () => {
  it('takes the brackets and the pair auto-pairing added', () => {
    // What the editor holds after `[[` is typed with auto-pairing on.
    expect(triggerRange('See [[', ']] and more')).toEqual({ from: -2, to: 2 });
  });

  it('takes only what is there when nothing was auto-paired', () => {
    expect(triggerRange('See [[', '')).toEqual({ from: -2, to: 0 });
    expect(triggerRange('See [[', 'text')).toEqual({ from: -2, to: 0 });
  });

  it('says nothing when the caret is not after two brackets', () => {
    expect(triggerRange('See [', ']')).toBeNull();
    expect(triggerRange('See [[x', ']]')).toBeNull();
    expect(triggerRange('', '')).toBeNull();
  });
});

describe('the link a chosen note becomes', () => {
  it('is the target alone when the title says nothing more', () => {
    expect(wikiLinkText('00_索引')).toBe('[[00_索引]]');
    expect(wikiLinkText('00_索引', '00_索引')).toBe('[[00_索引]]');
    expect(wikiLinkText('00_索引', '  ')).toBe('[[00_索引]]');
  });

  it('carries the title when it differs, as this vault writes them', () => {
    expect(wikiLinkText('合作方/00_索引', '合作方'))
      .toBe('[[合作方/00_索引|合作方]]');
  });
});
