/**
 * Workspace message validation.
 *
 * Same discipline as the other contract families: every message crossing the
 * process boundary is parsed here, in shared code, so main and renderer cannot
 * drift into disagreeing about what a valid message is.
 */

import { isEntryName } from './entry-names';
import {
  ENTRY_ACTIONS,
  MAX_CONTENT_QUERY,
  NOTO_WORKSPACE_VERSION,
  WORKSPACE_MENU_COMMANDS,
  type WorkspaceEntryActionV1,
  type WorkspaceEntryReplyV1,
  type WorkspaceEntryRequestV1,
  type WorkspaceRenameRowEventV1,
  type WorkspaceGitMarksV1,
  GIT_CHANGES,
  MAX_GIT_MARKS,
  type WorkspaceExportReplyV1,
  type WorkspaceExportRequestV1,
  EXPORT_KINDS,
  type WorkspaceExportKindV1,
  WorkspacePasteEventV1,
  MAX_PASTE_TEXT,
  WorkspaceLinkV1,
  WorkspaceLinksReplyV1,
  WorkspaceTagIndexReplyV1,
  WorkspaceTagSummaryV1,
  WorkspaceNotesByTagRequestV1,
  WorkspaceNotesByTagReplyV1,
  WorkspaceTagNoteV1,
  WorkspaceRemoteEventV1,
  WorkspaceDirtyEventV1,
  WorkspaceTextRequestV1,
  WorkspaceTextReplyV1,
} from './contracts';
import type {
  RecentFileV1,
  WorkspaceIndexEntryV1,
  WorkspaceIndexReplyV1,
  WorkspaceContentLineV1,
  WorkspaceContentMatchV1,
  WorkspaceContentReplyV1,
  WorkspaceContentRequestV1,
  WorkspaceRevealReplyV1,
  WorkspaceRevealRequestV1,
  WorkspaceRevealTargetV1,
  WorkspaceDocumentEventV1,
  WorkspaceMenuCommandV1,
  WorkspaceMenuEventV1,
  WorkspaceOpenPathRequestV1,
  WorkspaceOpenReplyV1,
  WorkspaceCodeViewV1,
  WorkspaceCodeViewEventV1,
  WorkspaceRecentReplyV1,
  WorkspaceRequestV1,
  WorkspaceResultV1,
  WorkspaceSaveAsReplyV1,
  WorkspaceTabRequestV1,
  WorkspaceTabV1,
  WorkspaceTabsEventV1,
  WorkspaceClosedEventV1,
  WorkspaceEntryV1,
  WorkspaceFolderEventV1,
  WorkspaceFolderReplyV1,
  WorkspaceFolderRequestV1,
  WorkspaceNewFileReplyV1,
  WorkspaceTreeMenuReplyV1,
  WorkspaceTreeMenuRequestV1,
  WorkspaceOpenExternalReplyV1,
  WorkspaceOpenExternalRequestV1,
} from './contracts';
import { isFileTruthOpenReplyV1 } from '../../file-truth/v1/validate';

const requestId = /^[A-Za-z0-9._:-]{1,96}$/;
const menuCommands: readonly WorkspaceMenuCommandV1[] = WORKSPACE_MENU_COMMANDS;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));

export function isWorkspaceRequestV1(value: unknown): value is WorkspaceRequestV1 {
  return record(value) && exact(value, ['version', 'requestId'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId);
}

export function isWorkspaceOpenPathRequestV1(value: unknown): value is WorkspaceOpenPathRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'path'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096;
}

/** Activate and close share a shape, so they share a validator. */
export function isWorkspaceTabRequestV1(value: unknown): value is WorkspaceTabRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'path'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096;
}

function isTab(value: unknown): value is WorkspaceTabV1 {
  return record(value) && exact(value, ['path', 'name', 'documentId', 'active', 'activatedAt'])
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && typeof value.name === 'string' && value.name.length <= 512
    && typeof value.documentId === 'string' && value.documentId.startsWith('noto-doc-v3:')
    && typeof value.active === 'boolean'
    && Number.isSafeInteger(value.activatedAt) && Number(value.activatedAt) >= 0;
}

export function isWorkspaceTabsEventV1(value: unknown): value is WorkspaceTabsEventV1 {
  return record(value) && exact(value, ['version', 'tabs']) && value.version === 1
    && Array.isArray(value.tabs) && value.tabs.length <= 64 && value.tabs.every(isTab);
}

export function isWorkspaceClosedEventV1(value: unknown): value is WorkspaceClosedEventV1 {
  return record(value) && exact(value, ['version']) && value.version === 1;
}

export const isWorkspaceTabsResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceTabsEventV1> =>
  isResult(value, id, isWorkspaceTabsEventV1);

export function isWorkspaceFolderRequestV1(value: unknown): value is WorkspaceFolderRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'path'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096;
}

function isEntry(value: unknown): value is WorkspaceEntryV1 {
  return record(value) && exact(value, ['name', 'path', 'kind', 'modifiedMs'])
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 512
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && (value.kind === 'file' || value.kind === 'directory')
    && typeof value.modifiedMs === 'number' && Number.isFinite(value.modifiedMs);
}

function isFolderReply(value: unknown): value is WorkspaceFolderReplyV1 {
  return record(value) && exact(value, ['version', 'entries']) && value.version === 1
    && Array.isArray(value.entries) && value.entries.length <= 4096 && value.entries.every(isEntry);
}

export function isWorkspaceFolderEventV1(value: unknown): value is WorkspaceFolderEventV1 {
  return record(value) && exact(value, ['version', 'root', 'name', 'chosen']) && value.version === 1
    && (value.root === null || (typeof value.root === 'string' && value.root.length <= 4096))
    && (value.name === null || (typeof value.name === 'string' && value.name.length <= 512))
    && typeof value.chosen === 'boolean';
}

export const isWorkspaceFolderResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceFolderEventV1> =>
  isResult(value, id, isWorkspaceFolderEventV1);

export const isWorkspaceListResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceFolderReplyV1> =>
  isResult(value, id, isFolderReply);

function isRecentFile(value: unknown): value is RecentFileV1 {
  return record(value) && exact(value, ['path', 'name', 'openedAt'])
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && typeof value.name === 'string' && value.name.length <= 512
    && Number.isSafeInteger(value.openedAt) && Number(value.openedAt) >= 0;
}

function isResult<T>(value: unknown, expectedRequestId: string,
  validateValue: (candidate: unknown) => candidate is T): value is WorkspaceResultV1<T> {
  if (!record(value) || value.requestId !== expectedRequestId || typeof value.ok !== 'boolean') return false;
  if (value.ok) return exact(value, ['ok', 'requestId', 'value']) && validateValue(value.value);
  return exact(value, ['ok', 'requestId', 'error']) && record(value.error)
    && exact(value.error, ['code', 'message'])
    && ['BAD_REQUEST', 'WORKSPACE_FAILED'].includes(String(value.error.code))
    && typeof value.error.message === 'string' && value.error.message.length > 0
    && value.error.message.length <= 2048;
}

function isCodeView(value: unknown): value is WorkspaceCodeViewV1 {
  return record(value) && exact(value, ['path', 'name', 'language', 'content', 'notice', 'truncated'])
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 512
    && typeof value.language === 'string' && value.language.length <= 64
    && typeof value.content === 'string' && value.content.length <= 5_000_000
    && (value.notice === null || (typeof value.notice === 'string' && value.notice.length <= 512))
    && typeof value.truncated === 'boolean';
}

function isOpenedNote(value: unknown): boolean {
  return record(value) && exact(value, ['path', 'documentId'])
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && typeof value.documentId === 'string' && value.documentId.startsWith('noto-doc-v3:');
}

function isOpenReply(value: unknown): value is WorkspaceOpenReplyV1 {
  if (!record(value) || value.version !== 1) return false;
  if (exact(value, ['version', 'opened'])) {
    // The document came on `documentOpened`; the reply only names it.
    return value.opened === null || isOpenedNote(value.opened);
  }
  return exact(value, ['version', 'codeView']) && isCodeView(value.codeView);
}

export function isWorkspaceCodeViewEventV1(value: unknown): value is WorkspaceCodeViewEventV1 {
  return record(value) && exact(value, ['version', 'codeView']) && value.version === 1
    && (value.codeView === null || isCodeView(value.codeView));
}

function isSaveAsReply(value: unknown): value is WorkspaceSaveAsReplyV1 {
  return record(value) && exact(value, ['version', 'path']) && value.version === 1
    && (value.path === null || (typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096));
}

function isRecentReply(value: unknown): value is WorkspaceRecentReplyV1 {
  return record(value) && exact(value, ['version', 'files']) && value.version === 1
    && Array.isArray(value.files) && value.files.length <= 64 && value.files.every(isRecentFile);
}

export const isWorkspaceOpenResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceOpenReplyV1> =>
  isResult(value, id, isOpenReply);

export const isWorkspaceSaveAsResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceSaveAsReplyV1> =>
  isResult(value, id, isSaveAsReply);

export const isWorkspaceRecentResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceRecentReplyV1> =>
  isResult(value, id, isRecentReply);

export function isWorkspaceDocumentEventV1(value: unknown): value is WorkspaceDocumentEventV1 {
  return record(value) && exact(value, ['version', 'opened']) && value.version === 1
    && isFileTruthOpenReplyV1(value.opened);
}

export function isWorkspaceMenuEventV1(value: unknown): value is WorkspaceMenuEventV1 {
  return record(value) && exact(value, ['version', 'command']) && value.version === 1
    && menuCommands.includes(value.command as WorkspaceMenuCommandV1);
}

function isWorkspaceLinkV1(value: unknown): value is WorkspaceLinkV1 {
  return record(value) && exact(value, ['path', 'relativePath', 'title'])
    && typeof value.path === 'string' && value.path.length > 0
    && typeof value.relativePath === 'string' && typeof value.title === 'string';
}

export function isWorkspaceLinksReplyV1(value: unknown): value is WorkspaceLinksReplyV1 {
  return record(value)
    && exact(value, ['version', 'available', 'known', 'generatedAt', 'backlinks', 'links', 'related'])
    && value.version === 1
    && typeof value.available === 'boolean' && typeof value.known === 'boolean'
    && (value.generatedAt === null || typeof value.generatedAt === 'string')
    && Array.isArray(value.backlinks) && value.backlinks.every(isWorkspaceLinkV1)
    && Array.isArray(value.links) && value.links.every(isWorkspaceLinkV1)
    && Array.isArray(value.related) && value.related.every(isWorkspaceLinkV1);
}

export const isWorkspaceLinksResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceLinksReplyV1> => isResult(value, id, isWorkspaceLinksReplyV1);

function isWorkspaceTagSummaryV1(value: unknown): value is WorkspaceTagSummaryV1 {
  return record(value) && exact(value, ['tag', 'count'])
    && typeof value.tag === 'string' && value.tag.length > 0 && value.tag.length <= 128
    && typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count >= 0;
}

export function isWorkspaceTagIndexReplyV1(value: unknown): value is WorkspaceTagIndexReplyV1 {
  return record(value)
    && exact(value, ['version', 'tags', 'truncated'])
    && value.version === 1
    && Array.isArray(value.tags) && value.tags.every(isWorkspaceTagSummaryV1)
    && typeof value.truncated === 'boolean';
}

export const isWorkspaceTagIndexResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceTagIndexReplyV1> => isResult(value, id, isWorkspaceTagIndexReplyV1);

export function isWorkspaceNotesByTagRequestV1(value: unknown): value is WorkspaceNotesByTagRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'tag']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.tag === 'string' && value.tag.length > 0 && value.tag.length <= 128;
}

function isWorkspaceTagNoteV1(value: unknown): value is WorkspaceTagNoteV1 {
  return record(value) && exact(value, ['path', 'relativePath', 'title'])
    && typeof value.path === 'string' && value.path.length > 0
    && typeof value.relativePath === 'string' && typeof value.title === 'string';
}

export function isWorkspaceNotesByTagReplyV1(value: unknown): value is WorkspaceNotesByTagReplyV1 {
  return record(value)
    && exact(value, ['version', 'tag', 'notes'])
    && value.version === 1
    && typeof value.tag === 'string'
    && Array.isArray(value.notes) && value.notes.every(isWorkspaceTagNoteV1);
}

export const isWorkspaceNotesByTagResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceNotesByTagReplyV1> => isResult(value, id, isWorkspaceNotesByTagReplyV1);

export function isWorkspaceTextRequestV1(value: unknown): value is WorkspaceTextRequestV1 {
  return record(value) && exact(value, ['version', 'requestId']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId);
}

export function isWorkspaceTextReplyV1(value: unknown): value is WorkspaceTextReplyV1 {
  return record(value) && exact(value, ['version', 'requestId', 'markdown']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && (value.markdown === null || typeof value.markdown === 'string');
}

export function isWorkspaceDirtyEventV1(value: unknown): value is WorkspaceDirtyEventV1 {
  return record(value) && exact(value, ['version', 'dirty'])
    && value.version === 1 && typeof value.dirty === 'boolean';
}

export function isWorkspaceRemoteEventV1(value: unknown): value is WorkspaceRemoteEventV1 {
  return record(value) && exact(value, ['version', 'listening', 'port']) && value.version === 1
    && typeof value.listening === 'boolean'
    && (value.port === null || (typeof value.port === 'number' && Number.isSafeInteger(value.port)));
}

export function isWorkspacePasteEventV1(value: unknown): value is WorkspacePasteEventV1 {
  return record(value)
    && (exact(value, ['version', 'text']) || exact(value, ['version', 'text', 'at']))
    && value.version === 1
    && typeof value.text === 'string' && value.text.length <= MAX_PASTE_TEXT
    && (value.at === undefined || value.at === 'caret' || value.at === 'end');
}

function isIndexEntryV1(value: unknown): value is WorkspaceIndexEntryV1 {
  return record(value) && exact(value, ['path', 'name', 'relativePath'])
    && typeof value.path === 'string' && value.path.length > 0
    && typeof value.name === 'string'
    && typeof value.relativePath === 'string';
}

export function isWorkspaceIndexReplyV1(value: unknown): value is WorkspaceIndexReplyV1 {
  return record(value) && exact(value, ['version', 'root', 'entries', 'truncated'])
    && value.version === 1
    && (value.root === null || typeof value.root === 'string')
    && typeof value.truncated === 'boolean'
    && Array.isArray(value.entries) && value.entries.every(isIndexEntryV1);
}

export function isWorkspaceIndexResultV1(
  value: unknown,
  expectedRequestId: string,
): value is WorkspaceResultV1<WorkspaceIndexReplyV1> {
  if (!record(value) || value.requestId !== expectedRequestId) return false;
  if (value.ok === true) return isWorkspaceIndexReplyV1(value.value);
  return value.ok === false && record(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

const revealTargets: readonly WorkspaceRevealTargetV1[] = ['folder', 'document'];

export function isWorkspaceRevealRequestV1(value: unknown): value is WorkspaceRevealRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'target'])
    && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && revealTargets.includes(value.target as WorkspaceRevealTargetV1);
}

/**
 * The only schemes a note may send to the operating system.
 *
 * Everything else, `file:` most of all, is refused. A URL in a note is text
 * somebody else may have written, and `shell.openExternal` will launch a
 * handler for any scheme the machine knows.
 */
const OPENABLE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * The URL to open, normalised, or null when it is not one to open.
 *
 * The normalised form is what the caller must hand on, not the string it was
 * given. The parser this checks with and the one the operating system opens
 * with do not have to agree, and they do not: `https:/\/\evil.com` parses
 * here as `https://evil.com/`, a tab inside a host is dropped, a newline
 * inside a scheme is dropped. Checking one string and opening another is the
 * whole of that bug class, so only the checked string is ever opened.
 */
export function openableExternalUrl(value: string): string | null {
  if (value.length === 0 || value.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!OPENABLE_SCHEMES.has(parsed.protocol)) return null;
  return parsed.href;
}

export function isOpenableExternalUrl(value: string): boolean {
  return openableExternalUrl(value) !== null;
}

export function isWorkspaceOpenExternalRequestV1(value: unknown): value is WorkspaceOpenExternalRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'url'])
    && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.url === 'string' && isOpenableExternalUrl(value.url);
}

export function isWorkspaceOpenExternalReplyV1(value: unknown): value is WorkspaceOpenExternalReplyV1 {
  return record(value) && exact(value, ['version', 'opened'])
    && value.version === 1 && typeof value.opened === 'boolean';
}

export const isWorkspaceOpenExternalResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceOpenExternalReplyV1> =>
  isResult(value, id, isWorkspaceOpenExternalReplyV1);

export function isWorkspaceNewFileReplyV1(value: unknown): value is WorkspaceNewFileReplyV1 {
  return record(value) && exact(value, ['version', 'created', 'path'])
    && value.version === 1 && typeof value.created === 'boolean'
    && (value.path === null || (typeof value.path === 'string' && value.path.length <= 4096));
}

export const isWorkspaceNewFileResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceNewFileReplyV1> =>
  isResult(value, id, isWorkspaceNewFileReplyV1);

export function isWorkspaceTreeMenuRequestV1(value: unknown): value is WorkspaceTreeMenuRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'path', 'kind'])
    && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && (value.kind === 'file' || value.kind === 'directory');
}

export function isWorkspaceTreeMenuReplyV1(value: unknown): value is WorkspaceTreeMenuReplyV1 {
  return record(value) && exact(value, ['version', 'accepted'])
    && value.version === 1 && typeof value.accepted === 'boolean';
}

export const isWorkspaceTreeMenuResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceTreeMenuReplyV1> =>
  isResult(value, id, isWorkspaceTreeMenuReplyV1);

export function isWorkspaceRevealReplyV1(value: unknown): value is WorkspaceRevealReplyV1 {
  return record(value) && exact(value, ['version', 'revealed'])
    && value.version === 1 && typeof value.revealed === 'boolean';
}

export const isWorkspaceRevealResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceRevealReplyV1> => isResult(value, id, isWorkspaceRevealReplyV1);

export function isWorkspaceContentRequestV1(value: unknown): value is WorkspaceContentRequestV1 {
  return record(value)
    && exact(value, ['version', 'requestId', 'query', 'scope', 'caseSensitive', 'wholeWord', 'regex'])
    && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.query === 'string' && value.query.length <= MAX_CONTENT_QUERY
    && typeof value.caseSensitive === 'boolean' && typeof value.wholeWord === 'boolean'
    && typeof value.regex === 'boolean'
    && typeof value.scope === 'string' && value.scope.length <= 1024 && !value.scope.startsWith('/');
}

function isContentLineV1(value: unknown): value is WorkspaceContentLineV1 {
  return record(value) && exact(value, ['line', 'lineNumber', 'column', 'length'])
    && typeof value.line === 'string'
    && Number.isSafeInteger(value.lineNumber) && Number.isSafeInteger(value.column)
    && typeof value.length === 'number' && Number.isSafeInteger(value.length) && value.length >= 0;
}

function isContentMatchV1(value: unknown): value is WorkspaceContentMatchV1 {
  return record(value) && exact(value, ['path', 'name', 'relativePath', 'occurrences', 'lines'])
    && typeof value.path === 'string' && value.path.length > 0
    && typeof value.name === 'string' && typeof value.relativePath === 'string'
    && Number.isSafeInteger(value.occurrences)
    && Array.isArray(value.lines) && value.lines.every(isContentLineV1);
}

export function isWorkspaceContentReplyV1(value: unknown): value is WorkspaceContentReplyV1 {
  return record(value) && exact(value, ['version', 'matches', 'scanned', 'truncated', 'timedOut', 'invalidPattern'])
    && value.version === 1
    && Number.isSafeInteger(value.scanned)
    && typeof value.truncated === 'boolean' && typeof value.timedOut === 'boolean'
    && typeof value.invalidPattern === 'boolean'
    && Array.isArray(value.matches) && value.matches.every(isContentMatchV1);
}

export const isWorkspaceContentResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceContentReplyV1> => isResult(value, id, isWorkspaceContentReplyV1);

export { isEntryName };

export function isWorkspaceEntryRequestV1(value: unknown): value is WorkspaceEntryRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'action', 'target', 'name', 'destination'])
    && value.version === NOTO_WORKSPACE_VERSION
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && ENTRY_ACTIONS.includes(value.action as WorkspaceEntryActionV1)
    && typeof value.target === 'string' && value.target.length > 0 && value.target.length <= 4096
    // A name is one segment or nothing at all. The action that needs one and
    // did not get one is refused in main, where the kind of entry is known.
    && (value.name === null || isEntryName(value.name))
    && (value.destination === null
      || (typeof value.destination === 'string' && value.destination.length > 0 && value.destination.length <= 4096));
}

export function isWorkspaceEntryReplyV1(value: unknown): value is WorkspaceEntryReplyV1 {
  if (!record(value) || value.version !== NOTO_WORKSPACE_VERSION) return false;
  if (value.done === true) {
    return exact(value, ['version', 'done', 'path'])
      && typeof value.path === 'string' && value.path.length > 0;
  }
  return value.done === false && exact(value, ['version', 'done', 'reason'])
    && ['no-folder', 'outside-root', 'bad-name', 'exists', 'unsaved-changes', 'busy',
      'trash-failed', 'into-itself', 'failed'].includes(String(value.reason));
}

export const isWorkspaceEntryResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceEntryReplyV1> =>
  isResult(value, id, isWorkspaceEntryReplyV1);

export function isWorkspaceRenameRowEventV1(value: unknown): value is WorkspaceRenameRowEventV1 {
  return record(value) && exact(value, ['version', 'path', 'intent'])
    && value.version === NOTO_WORKSPACE_VERSION
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && (value.intent === 'rename' || value.intent === 'new-folder');
}

const isMarkPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;

export function isWorkspaceGitMarksV1(value: unknown): value is WorkspaceGitMarksV1 {
  return record(value) && exact(value, ['version', 'root', 'files', 'folders'])
    && value.version === NOTO_WORKSPACE_VERSION
    && (value.root === null || isMarkPath(value.root))
    && Array.isArray(value.files) && value.files.length <= MAX_GIT_MARKS
    && value.files.every((entry: unknown) => Array.isArray(entry) && entry.length === 2
      && isMarkPath(entry[0]) && GIT_CHANGES.includes(entry[1]))
    && Array.isArray(value.folders) && value.folders.length <= MAX_GIT_MARKS
    && value.folders.every(isMarkPath);
}

export const isWorkspaceGitMarksResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceGitMarksV1> =>
  isResult(value, id, isWorkspaceGitMarksV1);

export function isWorkspaceExportRequestV1(value: unknown): value is WorkspaceExportRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'target', 'html', 'title', 'dirty'])
    && value.version === NOTO_WORKSPACE_VERSION
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && EXPORT_KINDS.includes(value.target as WorkspaceExportKindV1)
    // A whole document of markup. The ceiling is the same one a save uses for
    // the markdown it came from, since HTML is never smaller than its source.
    && (value.html === null || (typeof value.html === 'string' && value.html.length <= 64 * 1024 * 1024))
    && typeof value.title === 'string' && value.title.length <= 512
    && typeof value.dirty === 'boolean';
}

export function isWorkspaceExportReplyV1(value: unknown): value is WorkspaceExportReplyV1 {
  if (!record(value) || value.version !== NOTO_WORKSPACE_VERSION) return false;
  if (value.exported === true) {
    return exact(value, ['version', 'exported', 'path'])
      && typeof value.path === 'string' && value.path.length > 0;
  }
  return value.exported === false && exact(value, ['version', 'exported', 'reason'])
    && ['no-document', 'unsaved', 'cancelled', 'no-pandoc', 'failed'].includes(String(value.reason));
}

export const isWorkspaceExportResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceExportReplyV1> =>
  isResult(value, id, isWorkspaceExportReplyV1);
