import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isFileTruthOpenResultV1 } from '../../src/shared/file-truth/v1/validate';

describe('file_truth open with no document', () => {
  it('accepts NO_DOCUMENT_OPEN as a quiet result, not only transport failure', () => {
    expect(isFileTruthOpenResultV1({
      ok: false,
      requestId: 'ft-open:1',
      error: { code: 'NO_DOCUMENT_OPEN', message: 'NO_DOCUMENT_OPEN: open a document first' },
    }, 'ft-open:1')).toBe(true);

    expect(isFileTruthOpenResultV1({
      ok: false,
      requestId: 'ft-open:1',
      error: { code: 'FILE_TRUTH_TRANSPORT_FAILED', message: 'disk blew up' },
    }, 'ft-open:1')).toBe(true);
  });

  it('does not log file_truth_transport_failed for NO_DOCUMENT_OPEN', async () => {
    const handlers = await readFile(
      new URL('../../src/main/file-truth/v1/register-file-truth-handlers.ts', import.meta.url),
      'utf8',
    );
    expect(handlers).toContain("message.startsWith('NO_DOCUMENT_OPEN:')");
    expect(handlers).toContain("code: 'NO_DOCUMENT_OPEN'");
    // The transport-failed log must sit after the quiet branch, not alone.
    const quietIdx = handlers.indexOf("message.startsWith('NO_DOCUMENT_OPEN:')");
    const logIdx = handlers.indexOf("file_truth_transport_failed");
    expect(quietIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(quietIdx);
  });

  it('renderer treats a failed open as No document, not a scare banner', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    const open = app.slice(
      app.indexOf('const open = async () => {'),
      app.indexOf('void open();'),
    );
    expect(open).toContain('if (!result.ok)');
    expect(open).toContain("setState('No document')");
    expect(open).toContain('ordinary first-run state');
    // Scare path stays in the catch only (thrown validation / unexpected).
    expect(open).toMatch(/catch \(error\)[\s\S]*Save failed/);
  });
});
