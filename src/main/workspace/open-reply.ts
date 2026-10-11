/**
 * The IPC reply to an open or a tab switch.
 *
 * Kept apart from the handler module so it can be tested without Electron.
 */

import type { FileTruthOpenReplyV1 } from '../../shared/file-truth/v1/contracts';
import {
  NOTO_WORKSPACE_VERSION,
  type WorkspaceOpenedNoteV1,
  type WorkspaceOpenReplyV1,
} from '../../shared/workspace/v1/contracts';
import type { WorkspaceSessionOpenV1 } from './session';

/**
 * The reply names the note; it does not carry it.
 *
 * The session has already published the full document on `documentOpened`
 * (opens and activations both do, before they return), and that event is what
 * the renderer adopts. Sending it again here doubled the IPC payload and the
 * preload's hash check of it on every open.
 */
export function openedNote(opened: FileTruthOpenReplyV1): WorkspaceOpenedNoteV1 {
  return { path: opened.path, documentId: opened.document.documentId };
}

export function openReply(result: WorkspaceSessionOpenV1): WorkspaceOpenReplyV1 {
  return 'codeView' in result
    ? result
    : { version: NOTO_WORKSPACE_VERSION, opened: openedNote(result.opened) };
}
