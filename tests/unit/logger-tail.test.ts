/**
 * The main log, read back and kept to a size.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/main/logger';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('the main log', () => {
  it('gives back its last events, newest last, and only those an event name starts', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'noto-log-'));
    const logger = createLogger(directory);
    for (let index = 0; index < 5; index += 1) logger.log('workspace_document_opened', { openCount: index });
    logger.log('workspace_operation_failed', { error: 'Too many documents are open.' });
    expect(logger.tail(2).map((entry) => entry.event)).toEqual(['workspace_document_opened', 'workspace_operation_failed']);
    expect(logger.tail(10, 'workspace_operation')).toEqual([expect.objectContaining({ error: 'Too many documents are open.' })]);
    expect(logger.tail(3, 'workspace_document').map((entry) => entry.openCount)).toEqual([2, 3, 4]);
  });

  it('moves a full log aside and starts a new one, keeping one previous file', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'noto-log-'));
    const logger = createLogger(directory, { rotateBytes: 2_000 });
    for (let index = 0; index < 600; index += 1) logger.log('filler', { index, padding: 'x'.repeat(40) });
    expect(existsSync(path.join(directory, 'main.1.ndjson'))).toBe(true);
    // The size is checked every 200 writes, so the current file holds at most
    // that many lines of the 600 written.
    const current = (await readFile(logger.filePath, 'utf8')).trim().split('\n');
    expect(current.length).toBeLessThanOrEqual(200);
    expect(logger.tail(1)[0]).toMatchObject({ event: 'filler', index: 599 });
  });

  it('reads nothing, rather than throwing, before anything is written', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'noto-log-'));
    expect(createLogger(directory).tail(10)).toEqual([]);
  });
});
