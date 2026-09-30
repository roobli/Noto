import { describe, expect, it } from 'vitest';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { opensWithFrontmatterFence, parseMarkdown, topLevelNodes } from '../../src/shared/markdown/v3/syntax';

const types = (text: string) => topLevelNodes(parseMarkdown(text)).map((node) => node.type);

describe('a note that opens with ---', () => {
  it('reads a list after a leading thematic break as a list', () => {
    expect(types('---\n\n- a\n- b\n')).toEqual(['thematicBreak', 'list']);
    expect(types('---\n\n1. a\n2. b\n')).toEqual(['thematicBreak', 'list']);
    expect(types('---\n\nText.\n\n- a\n')).toEqual(['thematicBreak', 'paragraph', 'list']);
    expect(types('---\r\n\r\n- a\r\n')).toEqual(['thematicBreak', 'list']);
  });

  it('still reads closed frontmatter as frontmatter', () => {
    expect(types('---\ntitle: x\n---\n\n- a\n')).toEqual(['yaml', 'list']);
    expect(types('---\r\ntitle: x\r\n---\r\n\r\nText.\r\n')).toEqual(['yaml', 'paragraph']);
    expect(types('---\n---\n\nText.\n')).toEqual(['yaml', 'paragraph']);
    expect(types('---\ntitle: x\n---')).toEqual(['yaml']);
    expect(types('---\rtitle: x\r---\r\rText.\r')).toEqual(['yaml', 'paragraph']);
  });

  it('knows a fence only when it opens on the first line and closes on its own line', () => {
    expect(opensWithFrontmatterFence('---\na: 1\n---\n')).toBe(true);
    expect(opensWithFrontmatterFence('---  \na: 1\n---\t\n')).toBe(true);
    expect(opensWithFrontmatterFence('---\ra: 1\r---\r')).toBe(true);
    expect(opensWithFrontmatterFence('---\n\n- a\n')).toBe(false);
    expect(opensWithFrontmatterFence('x\n---\na\n---\n')).toBe(false);
    expect(opensWithFrontmatterFence('----\na\n----\n')).toBe(false);
    expect(opensWithFrontmatterFence('---\na: 1\n--- not a fence\n')).toBe(false);
  });

  it('reports the right block kinds, so a list is drawn as a list', () => {
    expect(splitBlocks('---\n\n- a\n- b\n').spans.map((span) => span.kind)).toEqual(['thematic-break', 'bullet-list']);
    expect(splitBlocks('---\ntitle: x\n---\n\n- a\n').spans.map((span) => span.kind)).toEqual(['frontmatter', 'bullet-list']);
  });
});
