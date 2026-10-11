import { describe, expect, it } from 'vitest';
import { openReply, openedNote } from '../../src/main/workspace/open-reply';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { isWorkspaceOpenResultV1 } from '../../src/shared/workspace/v1/validate';
import type { FileTruthOpenReplyV1 } from '../../src/shared/file-truth/v1/contracts';

/**
 * An open sends the document to the renderer once.
 *
 * Main publishes the full open reply on `documentOpened`, and that is what the
 * renderer adopts. The invoke reply used to carry the same document again, so
 * an 8 MB note crossed IPC twice and the preload hashed both copies. The reply
 * now only names the note it brought to the front.
 */
function opened(text: string, filePath = '/notes/a.md'): FileTruthOpenReplyV1 {
  const parsed = parseDocument(new TextEncoder().encode(text));
  if (parsed.status !== 'parsed') throw new Error(parsed.message);
  return { path: filePath, document: toWire(parsed.document) } as unknown as FileTruthOpenReplyV1;
}

const result = (value: unknown) => ({ ok: true, requestId: 'r-1', value });

describe('the reply to an open', () => {
  it('names the note and leaves the document to the event', () => {
    const note = opened('# Title\n\nBody\n');
    const reply = openReply({ version: 1, opened: note });
    expect(reply).toEqual({
      version: 1,
      opened: { path: '/notes/a.md', documentId: note.document.documentId },
    });
    expect(JSON.stringify(reply)).not.toContain('Body');
    expect(isWorkspaceOpenResultV1(result(reply), 'r-1')).toBe(true);
  });

  it('passes a code view through untouched', () => {
    const codeView = { path: '/a.ts', name: 'a.ts', language: 'ts', content: 'x', notice: null, truncated: false };
    const reply = openReply({ version: 1, codeView });
    expect(reply).toEqual({ version: 1, codeView });
    expect(isWorkspaceOpenResultV1(result(reply), 'r-1')).toBe(true);
  });

  it('still accepts a dismissed dialog or a tab that is not open', () => {
    expect(isWorkspaceOpenResultV1(result({ version: 1, opened: null }), 'r-1')).toBe(true);
  });

  it('refuses a reply that carries the document again', () => {
    const note = opened('# Title\n\nBody\n');
    expect(isWorkspaceOpenResultV1(result({ version: 1, opened: note }), 'r-1')).toBe(false);
  });

  it('refuses a note that is not a v3 document', () => {
    const named = openedNote(opened('x\n'));
    expect(isWorkspaceOpenResultV1(result({ version: 1, opened: { ...named, documentId: 'other' } }), 'r-1')).toBe(false);
    expect(isWorkspaceOpenResultV1(result({ version: 1, opened: { ...named, path: '' } }), 'r-1')).toBe(false);
    expect(isWorkspaceOpenResultV1(result({ version: 1, opened: { ...named, extra: 1 } }), 'r-1')).toBe(false);
  });
});
