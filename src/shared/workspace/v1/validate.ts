/**
 * Workspace message validation.
 *
 * Same discipline as the other contract families: every message crossing the
 * process boundary is parsed here, in shared code, so main and renderer cannot
 * drift into disagreeing about what a valid message is.
 */

import { isEntryName } from './entry-names';
import { PROPOSAL_ID } from './contracts';
import {
  WORKSPACE_EXPORT_REFUSALS,
  ENTRY_ACTIONS,
  MAX_CONTENT_QUERY,
  NOTO_WORKSPACE_VERSION,
  WORKSPACE_MENU_COMMANDS,
  type WorkspaceEntryActionV1,
  type WorkspaceEntryReplyV1,
  type WorkspaceEntryRequestV1,
  type WorkspaceRenameRowEventV1,
  type WorkspaceGitMarksV1,
  type WorkspaceGitBlocksV1,
  MAX_GIT_BLOCKS,
  MAX_GIT_BLOCK_TEXT,
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
  NoteCommitV1,
  NoteMemoryV1,
  WorkspaceMemoryChangedV1,
  WorkspaceKeepMemoryReplyV1,
  WorkspaceTrustMemoryReplyV1,
  WorkspaceReviewActionV1,
  WorkspaceReviewReplyV1,
  WorkspaceReviewRequestV1,
  WorkspaceAgentActionV1,
  WorkspaceAgentRequestV1,
  WorkspaceAgentsReplyV1,
  WorkspaceMemoryAskReplyV1,
  WorkspaceMemoryAskRequestV1,
  WorkspaceMemoryFolderReplyV1,
  WorkspaceMemoryFolderRequestV1,
  WorkspaceMemoryPrivacyReplyV1,
  WorkspaceMemoryPrivacyRequestV1,
  WorkspaceNoteMemoryReplyV1,
  WorkspaceFolderMemoryReplyV1,
  WorkspaceFolderHistoryReplyV1,
  WorkspaceShowFolderInfoEventV1,
  WorkspaceLinksFollowedV1,
  WorkspaceUndoLinksReplyV1,
  WorkspaceUndoLinksRequestV1,
  FolderNoteV1,
  WorkspaceNoteHistoryReplyV1,
  WorkspaceNoteHistoryRequestV1,
  WorkspaceNotePassageReplyV1,
  WorkspaceNotePassageRequestV1,
  WorkspaceNoteVersionReplyV1,
  WorkspaceNoteVersionRequestV1,
  WorkspaceTagIndexReplyV1,
  WorkspaceTagSummaryV1,
  WorkspaceNotesByTagRequestV1,
  WorkspaceNotesByTagReplyV1,
  WorkspaceTagNoteV1,
  WorkspaceRemoteEventV1,
  WorkspaceDirtyEventV1,
  WorkspaceUnsavedEventV1,
  WorkspaceTextRequestV1,
  WorkspaceContextCommandV1,
  WorkspaceContextItemV1,
  WorkspaceContextReplyV1,
  WorkspaceContextRequestV1,
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
  return record(value)
    && (exact(value, ['version', 'requestId', 'path'])
      || (exact(value, ['version', 'requestId', 'path', 'from'])
        && typeof value.from === 'string' && value.from.length > 0 && value.from.length <= 4096))
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096;
}

/** Activate and close share a shape, so they share a validator. */
export function isWorkspaceTabRequestV1(value: unknown): value is WorkspaceTabRequestV1 {
  return record(value)
    && (exact(value, ['version', 'requestId', 'path'])
      || (exact(value, ['version', 'requestId', 'path', 'release']) && typeof value.release === 'boolean'))
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
  if (!record(value) || !exact(value, ['version', 'path', 'token']) || value.version !== 1) return false;
  if (value.path === null) return value.token === null;
  return typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && typeof value.token === 'string' && /^[0-9a-f]{32}$/.test(value.token);
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

export function isWorkspaceNoteHistoryRequestV1(value: unknown): value is WorkspaceNoteHistoryRequestV1 {
  return isWorkspaceFolderRequestV1(value);
}

export function isWorkspaceNotePassageRequestV1(value: unknown): value is WorkspaceNotePassageRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'path', 'text'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 256 * 1024;
}

const PASSAGE_STATES = new Set(['ok', 'not-found', 'untracked', 'not-git', 'slow', 'unavailable', 'outside']);

export function isWorkspaceNotePassageReplyV1(value: unknown): value is WorkspaceNotePassageReplyV1 {
  if (!record(value) || !exact(value, ['version', 'state', 'lines', 'commits']) || value.version !== 1) return false;
  const lines = value.lines;
  return typeof value.state === 'string' && PASSAGE_STATES.has(value.state)
    && (lines === null || (record(lines) && exact(lines, ['from', 'to']) && whole(lines.from) && whole(lines.to)
      && (lines.from as number) >= 1 && (lines.to as number) >= (lines.from as number)))
    && Array.isArray(value.commits) && value.commits.length <= 1000
    && value.commits.every((hash) => typeof hash === 'string' && /^[0-9a-f]{40,64}$/.test(hash));
}

export const isWorkspaceNotePassageResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceNotePassageReplyV1> => isResult(value, id, isWorkspaceNotePassageReplyV1);

export function isWorkspaceNoteVersionRequestV1(value: unknown): value is WorkspaceNoteVersionRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'path', 'commit', 'at'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && typeof value.commit === 'string' && /^[0-9a-f]{40,64}$/.test(value.commit)
    && typeof value.at === 'string' && value.at.length > 0 && value.at.length <= 4096;
}

const NOTE_CHANGES = new Set(['added', 'modified', 'renamed', 'copied', 'deleted', 'merge']);
const count = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isNoteCommitV1(value: unknown): value is NoteCommitV1 {
  return record(value)
    && exact(value, ['hash', 'time', 'author', 'subject', 'change', 'path', 'from', 'added', 'removed', 'tooling', 'sweeping'])
    && typeof value.hash === 'string' && /^[0-9a-f]{40,64}$/.test(value.hash)
    && time(value.time)
    && typeof value.author === 'string' && value.author.length <= 512
    && typeof value.subject === 'string' && value.subject.length <= 4096
    && typeof value.change === 'string' && NOTE_CHANGES.has(value.change)
    && typeof value.path === 'string' && value.path.length <= 4096
    && (value.from === null || (typeof value.from === 'string' && value.from.length <= 4096))
    && count(value.added) && count(value.removed)
    && typeof value.tooling === 'boolean' && typeof value.sweeping === 'boolean';
}

const HISTORY_STATES = new Set(['ok', 'untracked', 'not-git', 'slow', 'unavailable', 'outside']);

export function isWorkspaceNoteHistoryReplyV1(value: unknown): value is WorkspaceNoteHistoryReplyV1 {
  if (!record(value) || !exact(value, ['version', 'state', 'commits', 'more', 'uncommitted', 'file'])) return false;
  const { uncommitted, file } = value;
  return value.version === 1
    && typeof value.state === 'string' && HISTORY_STATES.has(value.state)
    && Array.isArray(value.commits) && value.commits.length <= 1000 && value.commits.every(isNoteCommitV1)
    && typeof value.more === 'boolean'
    && (uncommitted === null || (record(uncommitted) && exact(uncommitted, ['added', 'removed'])
      && count(uncommitted.added) && count(uncommitted.removed)))
    && (file === null || (record(file) && exact(file, ['created', 'modified', 'bytes'])
      && time(file.created) && time(file.modified) && count(file.bytes)));
}

export const isWorkspaceNoteHistoryResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceNoteHistoryReplyV1> => isResult(value, id, isWorkspaceNoteHistoryReplyV1);

export function isWorkspaceNoteVersionReplyV1(value: unknown): value is WorkspaceNoteVersionReplyV1 {
  return record(value) && exact(value, ['version', 'text'])
    && value.version === 1 && (value.text === null || typeof value.text === 'string');
}

export const isWorkspaceNoteVersionResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceNoteVersionReplyV1> => isResult(value, id, isWorkspaceNoteVersionReplyV1);

/** A short string, as the memory's titles, paths and phrases are. */
const text = (value: unknown, max = 4096) => typeof value === 'string' && value.length <= max;
const textOrNull = (value: unknown, max = 4096) => value === null || text(value, max);
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const whole = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const listOf = (value: unknown, max: number, each: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.length <= max && value.every((item) => record(item) && each(item));
const ORIGINS = new Set(['note', 'script', 'folder', 'config', 'default']);
const traced = (value: unknown, nullable: boolean) => record(value) && exact(value, ['value', 'from'])
  && (nullable ? textOrNull(value.value, 64) : text(value.value, 64))
  && typeof value.from === 'string' && ORIGINS.has(value.from);

function isNoteMemoryV1(value: unknown): value is NoteMemoryV1 {
  if (!record(value) || !exact(value, [
    'path', 'title', 'id', 'kind', 'known', 'sensitivity', 'status', 'tags', 'aliases', 'heat', 'supersededBy',
    'linksHere', 'linksHereCount', 'namedHere', 'namedHereCount', 'together', 'togetherCount', 'aboutSame',
    'outgoing', 'reads', 'readers', 'leadsHere', 'writes', 'agents',
  ])) return false;
  const { heat, outgoing, writes, supersededBy } = value;
  return text(value.path) && text(value.title) && textOrNull(value.id, 512)
    && traced(value.kind, false) && traced(value.known, true) && traced(value.sensitivity, false)
    && textOrNull(value.status, 512)
    && Array.isArray(value.tags) && value.tags.length <= 512 && value.tags.every((tag) => text(tag, 256))
    && Array.isArray(value.aliases) && value.aliases.length <= 512 && value.aliases.every((alias) => text(alias, 512))
    && record(heat) && exact(heat, ['heat', 'reads', 'writes', 'lastRead', 'lastWrite'])
    && number(heat.heat) && whole(heat.reads) && whole(heat.writes) && textOrNull(heat.lastRead, 64) && textOrNull(heat.lastWrite, 64)
    && (supersededBy === null || (record(supersededBy) && exact(supersededBy, ['path', 'title']) && text(supersededBy.path) && text(supersededBy.title)))
    && listOf(value.linksHere, 200, (item) => exact(item, ['path', 'title', 'relation', 'heat', 'reads'])
      && text(item.path) && text(item.title) && textOrNull(item.relation, 128) && number(item.heat) && whole(item.reads))
    && whole(value.linksHereCount)
    && listOf(value.namedHere, 200, (item) => exact(item, ['id', 'to', 'title', 'score', 'around'])
      && text(item.id, 128) && text(item.to) && text(item.title) && number(item.score)
      && Array.isArray(item.around) && item.around.length === 3 && item.around.every((part) => text(part, 1024)))
    && whole(value.namedHereCount)
    && listOf(value.together, 200, (item) => exact(item, ['path', 'title', 'type', 'count', 'weight', 'last'])
      && text(item.path) && text(item.title) && text(item.type, 64) && whole(item.count) && number(item.weight) && textOrNull(item.last, 64))
    && whole(value.togetherCount)
    && listOf(value.aboutSame, 200, (item) => exact(item, ['path', 'title', 'why', 'excerpt'])
      && text(item.path) && text(item.title) && Array.isArray(item.why) && item.why.length <= 16
      && item.why.every((reason) => text(reason, 512)) && text(item.excerpt, 8192))
    && record(outgoing) && exact(outgoing, ['count', 'broken', 'brokenCount']) && whole(outgoing.count) && whole(outgoing.brokenCount)
    && listOf(outgoing.broken, 1000, (item) => exact(item, ['target', 'line']) && text(item.target) && whole(item.line))
    && listOf(value.reads, 20000, (item) => exact(item, ['day', 'count']) && text(item.day, 10) && whole(item.count))
    && listOf(value.readers, 200, (item) => exact(item, ['actor', 'count', 'last']) && text(item.actor, 256) && whole(item.count) && text(item.last, 64))
    && listOf(value.leadsHere, 200, (item) => exact(item, ['from', 'query', 'count']) && textOrNull(item.from) && textOrNull(item.query, 1024) && whole(item.count))
    && record(writes) && exact(writes, ['commits', 'appends']) && whole(writes.commits) && whole(writes.appends)
    && listOf(value.agents, 200, (item) => exact(item, ['name', 'canSee', 'why']) && text(item.name, 256)
      && typeof item.canSee === 'boolean' && textOrNull(item.why, 512));
}

const MEMORY_STATES = new Set(['ok', 'no-memory', 'untrusted', 'opening', 'unknown', 'unavailable', 'outside']);
const KEEP_OUTCOMES = new Set(['made', 'cancelled', 'failed']);

export function isWorkspaceKeepMemoryReplyV1(value: unknown): value is WorkspaceKeepMemoryReplyV1 {
  return record(value) && exact(value, ['version', 'outcome', 'made']) && value.version === 1
    && typeof value.outcome === 'string' && KEEP_OUTCOMES.has(value.outcome)
    && Array.isArray(value.made) && value.made.length <= 64 && value.made.every((file) => text(file, 512))
    && (value.outcome === 'made' || value.made.length === 0);
}

export function isWorkspaceTrustMemoryReplyV1(value: unknown): value is WorkspaceTrustMemoryReplyV1 {
  return record(value) && exact(value, ['version', 'trusted']) && value.version === 1 && typeof value.trusted === 'boolean';
}

export const isWorkspaceTrustMemoryResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceTrustMemoryReplyV1> => isResult(value, id, isWorkspaceTrustMemoryReplyV1);

const REVIEW_KINDS = new Set(['stale', 'mention', 'together']);
const REVIEW_STATES = new Set(['ok', 'failed', 'no-memory', 'untrusted', 'opening', 'unavailable', 'outside']);
/** A suggestion's id: seven hex digits, as the vault makes them. */
const suggestionIdPattern = /^[0-9a-f]{7}$/;
/** As many as a Fix All in a folder that was reorganized may name. */
const ids = (value: unknown, max = 5000) => Array.isArray(value) && value.length <= max
  && value.every((id) => typeof id === 'string' && suggestionIdPattern.test(id));
const proposalId = (value: unknown) => typeof value === 'string' && PROPOSAL_ID.test(value) && !value.includes('..');
/** A folder-relative path, as the vault names notes: forward slashes, never up and out. */
const notePath = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !value.startsWith('/') && !value.split('/').includes('..') && !value.includes('\0');
const paths = (value: unknown, max = 2000) => Array.isArray(value) && value.length <= max && value.every(notePath);

const AGENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
/** Names a policy reserves, or that a parsed map treats as its own machinery. */
const RESERVED_AGENTS = new Set(['owner', 'default', '__proto__', 'constructor', 'prototype']);
/**
 * The one folder an agent may write in: a vault path that a policy pattern
 * can name as itself. `*` and `?` would make it a wildcard ("write in **"
 * reads as a folder and means everywhere), and a control character would put
 * lines of its own into the sheet that asks the person.
 */
// eslint-disable-next-line no-control-regex
const writeFolder = (value: unknown) => notePath(value) && !/[*?\u0000-\u001f\u007f]/.test(value as string);
const SENSITIVITY_LEVELS = new Set(['open', 'private', 'sealed']);

export function isWorkspaceAgentActionV1(value: unknown): value is WorkspaceAgentActionV1 {
  if (!record(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'list') return exact(value, ['kind']);
  if (value.kind === 'revoke') return exact(value, ['kind', 'name']) && typeof value.name === 'string' && AGENT_NAME.test(value.name);
  if (value.kind !== 'add') return false;
  return exact(value, ['kind', 'name', 'reads', 'may', 'writeIn'])
    && typeof value.name === 'string' && AGENT_NAME.test(value.name) && !RESERVED_AGENTS.has(value.name)
    && (value.reads === 'open' || value.reads === 'private')
    && (value.may === 'read' || value.may === 'propose' || value.may === 'write')
    && (value.may === 'write' ? writeFolder(value.writeIn) : value.writeIn === null);
}

export function isWorkspaceAgentRequestV1(value: unknown): value is WorkspaceAgentRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'action']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId) && isWorkspaceAgentActionV1(value.action);
}

const agentRow = (item: Record<string, unknown>) => exact(item, ['name', 'keys', 'reads', 'verbs', 'writes', 'revoked', 'implicit', 'lastRead', 'readCount'])
  && typeof item.name === 'string' && AGENT_NAME.test(item.name) && whole(item.keys)
  && typeof item.reads === 'string' && SENSITIVITY_LEVELS.has(item.reads)
  && Array.isArray(item.verbs) && item.verbs.length <= 16 && item.verbs.every((verb) => text(verb, 32))
  && Array.isArray(item.writes) && item.writes.length <= 64 && item.writes.every((pattern) => text(pattern, 512))
  && textOrNull(item.revoked, 64) && typeof item.implicit === 'boolean' && textOrNull(item.lastRead, 64) && whole(item.readCount);

export function isWorkspaceAgentsReplyV1(value: unknown): value is WorkspaceAgentsReplyV1 {
  return record(value) && exact(value, ['version', 'state', 'outcome', 'error', 'agents', 'key', 'setup']) && value.version === 1
    && (value.state === 'ok' || value.state === 'no-memory' || value.state === 'outside')
    && (value.outcome === 'done' || value.outcome === 'cancelled' || value.outcome === 'failed')
    && textOrNull(value.error, 4096) && listOf(value.agents, 200, agentRow)
    && (value.key === null || (typeof value.key === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value.key)))
    && (value.setup === null || (record(value.setup) && exact(value.setup, ['script', 'root'])
      && text(value.setup.script, 4096) && text(value.setup.root, 4096)));
}

export function isWorkspaceMemoryPrivacyRequestV1(value: unknown): value is WorkspaceMemoryPrivacyRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'note']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && (value.note === null || (text(value.note, 4096) && !(value.note as string).includes('\0')));
}

const level = (value: unknown) => typeof value === 'string' && SENSITIVITY_LEVELS.has(value);

export function isWorkspaceMemoryPrivacyReplyV1(value: unknown): value is WorkspaceMemoryPrivacyReplyV1 {
  return record(value) && exact(value, ['version', 'root', 'vault', 'folders', 'note']) && value.version === 1
    && textOrNull(value.root, 4096) && level(value.vault)
    && listOf(value.folders, 5000, (item) => exact(item, ['path', 'level']) && text(item.path, 4096) && level(item.level))
    && (value.note === null || (record(value.note) && exact(value.note, ['level', 'folder'])
      && (value.note.level === 'private' || value.note.level === 'sealed')
      && (value.note.folder === 'open' || value.note.folder === 'private')));
}

export const isWorkspaceMemoryPrivacyResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceMemoryPrivacyReplyV1> => isResult(value, id, isWorkspaceMemoryPrivacyReplyV1);

export function isWorkspaceMemoryFolderRequestV1(value: unknown): value is WorkspaceMemoryFolderRequestV1 {
  if (!record(value) || !exact(value, ['version', 'requestId', 'action']) || value.version !== 1
    || typeof value.requestId !== 'string' || !requestId.test(value.requestId) || !record(value.action)) return false;
  const action = value.action;
  if (action.kind === 'record') return exact(action, ['kind', 'on']) && typeof action.on === 'boolean';
  return (action.kind === 'status' || action.kind === 'rebuild' || action.kind === 'turn-off') && exact(action, ['kind']);
}

const FOLDER_STATES = new Set(['outside', 'no-memory', 'untrusted', 'opening', 'open', 'unavailable']);

export function isWorkspaceMemoryFolderReplyV1(value: unknown): value is WorkspaceMemoryFolderReplyV1 {
  return record(value) && exact(value, ['version', 'state', 'outcome', 'error', 'index', 'recording']) && value.version === 1
    && typeof value.state === 'string' && FOLDER_STATES.has(value.state)
    && (value.outcome === 'done' || value.outcome === 'cancelled' || value.outcome === 'failed')
    && textOrNull(value.error, 4096) && typeof value.recording === 'boolean'
    && (value.index === null || (record(value.index) && exact(value.index, ['notes', 'links', 'reads', 'bytes', 'refreshed'])
      && whole(value.index.notes) && whole(value.index.links) && whole(value.index.reads) && whole(value.index.bytes)
      && textOrNull(value.index.refreshed, 64)));
}

export const isWorkspaceMemoryFolderResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceMemoryFolderReplyV1> => isResult(value, id, isWorkspaceMemoryFolderReplyV1);

export function isWorkspaceMemoryAskRequestV1(value: unknown): value is WorkspaceMemoryAskRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'cue', 'note']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && typeof value.cue === 'string' && value.cue.trim().length > 0 && value.cue.length <= 500
    && (value.note === null || (text(value.note, 4096) && !(value.note as string).includes('\0')));
}

const ASK_STATES = new Set(['ok', 'no-memory', 'untrusted', 'opening', 'unavailable', 'outside']);

export function isWorkspaceMemoryAskReplyV1(value: unknown): value is WorkspaceMemoryAskReplyV1 {
  if (!record(value) || !exact(value, ['version', 'state', 'value']) || value.version !== 1) return false;
  if (typeof value.state !== 'string' || !ASK_STATES.has(value.state)) return false;
  if (value.state !== 'ok') return value.value === null;
  const pack = value.value;
  return record(pack) && exact(pack, ['cue', 'items', 'omitted', 'markdown']) && text(pack.cue, 500) && whole(pack.omitted)
    && text(pack.markdown, 1024 * 1024)
    && listOf(pack.items, 100, (item) => exact(item, ['path', 'title', 'kind', 'why', 'excerpt'])
      && notePath(item.path) && text(item.title, 512) && text(item.kind, 64)
      && Array.isArray(item.why) && item.why.length <= 20 && item.why.every((why) => text(why, 512)) && text(item.excerpt, 64 * 1024));
}

export const isWorkspaceMemoryAskResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceMemoryAskReplyV1> => isResult(value, id, isWorkspaceMemoryAskReplyV1);

export const isWorkspaceAgentsResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceAgentsReplyV1> => isResult(value, id, isWorkspaceAgentsReplyV1);

export function isWorkspaceReviewActionV1(value: unknown): value is WorkspaceReviewActionV1 {
  if (!record(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'summary':
      return exact(value, ['kind', 'counted']) && Array.isArray(value.counted) && value.counted.length <= 3
        && value.counted.every((kind) => typeof kind === 'string' && REVIEW_KINDS.has(kind));
    case 'suggestions':
      return exact(value, ['kind', 'type', 'offset', 'limit']) && typeof value.type === 'string' && REVIEW_KINDS.has(value.type)
        && whole(value.offset) && whole(value.limit) && (value.limit as number) <= 200;
    case 'proposal-file':
      return exact(value, ['kind', 'proposal', 'path']) && proposalId(value.proposal) && notePath(value.path);
    case 'accept':
    case 'reject':
      return exact(value, ['kind', 'proposal']) && proposalId(value.proposal);
    case 'link':
    case 'dismiss':
      return exact(value, ['kind', 'type', 'ids']) && typeof value.type === 'string' && REVIEW_KINDS.has(value.type)
        && ids(value.ids) && (value.ids as unknown[]).length > 0;
    case 'undismiss':
      return exact(value, ['kind', 'ids']) && (value.ids === 'all' || ids(value.ids));
    case 'dismissals':
    case 'undo':
      return exact(value, ['kind']);
    case 'mentions':
      return exact(value, ['kind', 'note']) && text(value.note, 4096) && (value.note as string).length > 0 && !(value.note as string).includes('\0');
    default:
      return false;
  }
}

export function isWorkspaceReviewRequestV1(value: unknown): value is WorkspaceReviewRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'action']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId) && isWorkspaceReviewActionV1(value.action);
}

const reviewProposal = (item: Record<string, unknown>) => exact(item, ['id', 'subject', 'author', 'time', 'files'])
  && proposalId(item.id) && text(item.subject, 1024) && text(item.author, 256) && text(item.time, 64)
  && listOf(item.files, 2000, (file) => exact(file, ['status', 'path']) && text(file.status, 8) && notePath(file.path));
const countOrNull = (value: unknown) => value === null || whole(value);
const reviewSuggestion = (item: Record<string, unknown>) => exact(item, ['id', 'type', 'from', 'to', 'toTitle', 'score', 'reason', 'line', 'around'])
  && ids([item.id]) && typeof item.type === 'string' && REVIEW_KINDS.has(item.type) && notePath(item.from) && notePath(item.to)
  && text(item.toTitle, 512) && number(item.score) && text(item.reason, 1024) && (item.line === null || whole(item.line))
  && (item.around === null || (Array.isArray(item.around) && item.around.length === 3 && item.around.every((part) => text(part, 1024))));

const reviewMention = (item: Record<string, unknown>) => exact(item, ['id', 'to', 'toTitle', 'score', 'around', 'replacement'])
  && ids([item.id]) && notePath(item.to) && text(item.toTitle, 512) && number(item.score)
  && Array.isArray(item.around) && item.around.length === 3 && item.around.every((part) => text(part, 1024))
  // One wiki link that still reads as the words it replaces: what the card offers is what is written.
  && text(item.replacement, 2048) && /^\[\[[^[\]\r\n]+\]\]$/.test(item.replacement as string)
  && ((item.replacement as string) === `[[${(item.around as string[])[1]}]]` || (item.replacement as string).endsWith(`|${(item.around as string[])[1]}]]`));

/** Whether a reply's value is what its action answers. */
const REVIEW_VALUES: { readonly [K in WorkspaceReviewActionV1['kind']]: (value: unknown) => boolean } = {
  summary: (value) => record(value) && exact(value, ['proposals', 'counts', 'dismissed'])
    && listOf(value.proposals, 500, reviewProposal) && whole(value.dismissed)
    && record(value.counts) && exact(value.counts, ['stale', 'mention', 'together'])
    && countOrNull(value.counts.stale) && countOrNull(value.counts.mention) && countOrNull(value.counts.together),
  suggestions: (value) => record(value) && exact(value, ['total', 'items']) && whole(value.total) && listOf(value.items, 200, reviewSuggestion),
  'proposal-file': (value) => record(value) && exact(value, ['base', 'proposed'])
    && textOrNull(value.base, 16 * 1024 * 1024) && textOrNull(value.proposed, 16 * 1024 * 1024),
  accept: (value) => record(value) && exact(value, ['applied', 'unchanged', 'conflicts', 'busy'])
    && paths(value.applied) && paths(value.unchanged) && paths(value.conflicts) && paths(value.busy),
  reject: (value) => value === null,
  link: (value) => record(value) && exact(value, ['linked', 'outdated', 'busy']) && ids(value.linked) && ids(value.outdated) && ids(value.busy),
  dismiss: (value) => record(value) && exact(value, ['count', 'missing']) && whole(value.count) && ids(value.missing),
  dismissals: (value) => listOf(value, 20_000, (item) => exact(item, ['id', 'type', 'from', 'to', 'time'])
    && ids([item.id]) && text(item.type, 32) && notePath(item.from) && notePath(item.to) && textOrNull(item.time, 64)),
  undismiss: (value) => record(value) && exact(value, ['count']) && whole(value.count),
  undo: (value) => value === null || (record(value) && exact(value, ['restored', 'changed', 'busy'])
    && paths(value.restored) && paths(value.changed) && paths(value.busy)),
  mentions: (value) => listOf(value, 50, reviewMention),
};

export function isWorkspaceReviewReplyV1(value: unknown, kind: WorkspaceReviewActionV1['kind']): value is WorkspaceReviewReplyV1 {
  if (!record(value) || !exact(value, ['version', 'state', 'value', 'error']) || value.version !== 1) return false;
  if (typeof value.state !== 'string' || !REVIEW_STATES.has(value.state) || !textOrNull(value.error, 4096)) return false;
  // Only an answer carries a value (null for `reject`, and for `undo` with nothing to take back).
  return value.state === 'ok' ? REVIEW_VALUES[kind](value.value) : value.value === null;
}

export const isWorkspaceReviewResultV1 = (
  value: unknown, id: string, kind: WorkspaceReviewActionV1['kind'],
): value is WorkspaceResultV1<WorkspaceReviewReplyV1> => isResult(value, id, (candidate): candidate is WorkspaceReviewReplyV1 => isWorkspaceReviewReplyV1(candidate, kind));

export const isWorkspaceKeepMemoryResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceKeepMemoryReplyV1> => isResult(value, id, isWorkspaceKeepMemoryReplyV1);

export function isWorkspaceMemoryChangedV1(value: unknown): value is WorkspaceMemoryChangedV1 {
  return record(value) && exact(value, ['version']) && value.version === 1;
}

export function isWorkspaceNoteMemoryReplyV1(value: unknown): value is WorkspaceNoteMemoryReplyV1 {
  return record(value) && exact(value, ['version', 'state', 'memory']) && value.version === 1
    && typeof value.state === 'string' && MEMORY_STATES.has(value.state)
    && (value.state === 'ok' ? isNoteMemoryV1(value.memory) : value.memory === null);
}

const FOLDER_GIT_STATES = new Set(['ok', 'not-git', 'slow', 'unavailable', 'outside']);

/** At most what main reads of a folder's history. */
export const FOLDER_COMMITS_MAX = 50;

export function isWorkspaceFolderHistoryReplyV1(value: unknown): value is WorkspaceFolderHistoryReplyV1 {
  return record(value) && exact(value, ['version', 'state', 'commits']) && value.version === 1
    && typeof value.state === 'string' && FOLDER_GIT_STATES.has(value.state)
    && Array.isArray(value.commits) && value.commits.length <= FOLDER_COMMITS_MAX
    && (value.state === 'ok' || value.commits.length === 0)
    && value.commits.every((commit) => record(commit)
      && exact(commit, ['hash', 'time', 'author', 'subject', 'notes', 'files'])
      && typeof commit.hash === 'string' && /^[0-9a-f]{40,64}$/.test(commit.hash)
      && whole(commit.time) && text(commit.author, 200) && text(commit.subject, 1000)
      && Array.isArray(commit.notes) && commit.notes.length <= 8 && commit.notes.every(notePath)
      && whole(commit.files) && (commit.files as number) >= commit.notes.length);
}

export const isWorkspaceFolderHistoryResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceFolderHistoryReplyV1> => isResult(value, id, isWorkspaceFolderHistoryReplyV1);

export function isWorkspaceShowFolderInfoEventV1(value: unknown): value is WorkspaceShowFolderInfoEventV1 {
  return record(value) && exact(value, ['version', 'path']) && value.version === 1
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096;
}

export function isWorkspaceLinksFollowedV1(value: unknown): value is WorkspaceLinksFollowedV1 {
  return record(value) && exact(value, ['version', 'pass', 'notes', 'links', 'held', 'left']) && value.version === 1
    && whole(value.pass) && whole(value.notes) && whole(value.links) && whole(value.held) && whole(value.left)
    && (value.links as number) >= (value.notes as number) && ((value.pass as number) > 0) === ((value.notes as number) > 0);
}

export function isWorkspaceUndoLinksRequestV1(value: unknown): value is WorkspaceUndoLinksRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'pass']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId) && whole(value.pass) && (value.pass as number) > 0;
}

export function isWorkspaceUndoLinksReplyV1(value: unknown): value is WorkspaceUndoLinksReplyV1 {
  return record(value) && exact(value, ['version', 'restored', 'kept']) && value.version === 1
    && whole(value.restored) && whole(value.kept);
}

export const isWorkspaceUndoLinksResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceUndoLinksReplyV1> => isResult(value, id, isWorkspaceUndoLinksReplyV1);

const isFolderNoteV1 = (value: unknown): value is FolderNoteV1 => record(value)
  && exact(value, ['path', 'title', 'heat', 'reads', 'lastRead'])
  && notePath(value.path) && text(value.title, 1024)
  && typeof value.heat === 'number' && Number.isFinite(value.heat) && value.heat >= 0
  && whole(value.reads) && textOrNull(value.lastRead, 64);

/** Items per list, as main asks the vault for them. */
export const FOLDER_LIST_MAX = 12;
const folderNotes = (value: unknown) => Array.isArray(value) && value.length <= FOLDER_LIST_MAX && value.every(isFolderNoteV1);

export function isWorkspaceFolderMemoryReplyV1(value: unknown): value is WorkspaceFolderMemoryReplyV1 {
  if (!record(value) || !exact(value, ['version', 'state', 'memory']) || value.version !== 1) return false;
  if (typeof value.state !== 'string' || value.state === 'unknown' || !MEMORY_STATES.has(value.state)) return false;
  if (value.state !== 'ok') return value.memory === null;
  const memory = value.memory;
  return record(memory) && exact(memory, ['folder', 'notes', 'warmest', 'mostRead', 'orphans', 'broken'])
    && typeof memory.folder === 'string' && memory.folder.length <= 1024 && (memory.folder === '' || notePath(memory.folder))
    && whole(memory.notes) && folderNotes(memory.warmest) && folderNotes(memory.mostRead)
    && record(memory.orphans) && exact(memory.orphans, ['count', 'items']) && whole(memory.orphans.count)
    && folderNotes(memory.orphans.items) && whole(memory.broken);
}

export const isWorkspaceFolderMemoryResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceFolderMemoryReplyV1> => isResult(value, id, isWorkspaceFolderMemoryReplyV1);

export const isWorkspaceNoteMemoryResultV1 = (
  value: unknown, id: string,
): value is WorkspaceResultV1<WorkspaceNoteMemoryReplyV1> => isResult(value, id, isWorkspaceNoteMemoryReplyV1);

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

/** A plugin's editor command: lowercase, dotted, as manifests name commands. */
const contextCommand = /^[a-z0-9][a-z0-9.-]{0,119}$/;
const MAX_CONTEXT_ITEMS = 8;

const coordinate = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= -100_000 && value <= 100_000;

function isWorkspaceContextItemV1(value: unknown): value is WorkspaceContextItemV1 {
  return record(value) && exact(value, ['command', 'title'])
    && typeof value.command === 'string' && contextCommand.test(value.command)
    && typeof value.title === 'string' && value.title.trim().length > 0 && value.title.length <= 80;
}

export function isWorkspaceContextRequestV1(value: unknown): value is WorkspaceContextRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'x', 'y']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && coordinate(value.x) && coordinate(value.y);
}

export function isWorkspaceContextReplyV1(value: unknown): value is WorkspaceContextReplyV1 {
  return record(value) && exact(value, ['version', 'requestId', 'items']) && value.version === 1
    && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && Array.isArray(value.items) && value.items.length <= MAX_CONTEXT_ITEMS
    && value.items.every(isWorkspaceContextItemV1);
}

export function isWorkspaceContextCommandV1(value: unknown): value is WorkspaceContextCommandV1 {
  return record(value) && exact(value, ['version', 'command']) && value.version === 1
    && typeof value.command === 'string' && contextCommand.test(value.command);
}

export function isWorkspaceDirtyEventV1(value: unknown): value is WorkspaceDirtyEventV1 {
  return record(value) && exact(value, ['version', 'dirty'])
    && value.version === 1 && typeof value.dirty === 'boolean';
}

/** More than this many loaded notes is past what the renderer keeps. */
const UNSAVED_PATHS_MAX = 64;

export function isWorkspaceUnsavedEventV1(value: unknown): value is WorkspaceUnsavedEventV1 {
  return record(value) && exact(value, ['version', 'paths']) && value.version === 1
    && Array.isArray(value.paths) && value.paths.length <= UNSAVED_PATHS_MAX
    && value.paths.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096);
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

/** The most rows one menu is for: a Shift-click across a folder of hundreds. */
export const TREE_MENU_ALSO_MAX = 2000;

export function isWorkspaceTreeMenuRequestV1(value: unknown): value is WorkspaceTreeMenuRequestV1 {
  return record(value)
    && (exact(value, ['version', 'requestId', 'path', 'kind'])
      || (exact(value, ['version', 'requestId', 'path', 'kind', 'also']) && Array.isArray(value.also) && value.also.length > 0
        && value.also.length <= TREE_MENU_ALSO_MAX
        && value.also.every((other) => typeof other === 'string' && other.length > 0 && other.length <= 4096)))
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
    && (value.intent === 'rename' || value.intent === 'new-folder' || value.intent === 'new-note');
}

const isMarkPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;

export function isWorkspaceGitMarksV1(value: unknown): value is WorkspaceGitMarksV1 {
  return record(value)
    && (exact(value, ['version', 'root', 'files', 'folders'])
      || (exact(value, ['version', 'root', 'files', 'folders', 'repository', 'realRoot'])
        && value.repository === true && isMarkPath(value.realRoot)))
    && value.version === NOTO_WORKSPACE_VERSION
    && (value.root === null || isMarkPath(value.root))
    && Array.isArray(value.files) && value.files.length <= MAX_GIT_MARKS
    && value.files.every((entry: unknown) => Array.isArray(entry) && entry.length === 2
      && isMarkPath(entry[0]) && GIT_CHANGES.includes(entry[1]))
    && Array.isArray(value.folders) && value.folders.length <= MAX_GIT_MARKS
    && value.folders.every(isMarkPath);
}

const isBlockId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const isBlockText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_GIT_BLOCK_TEXT;

export function isWorkspaceGitBlocksV1(value: unknown): value is WorkspaceGitBlocksV1 {
  return record(value) && exact(value, ['version', 'documentId', 'blocks', 'deleted'])
    && value.version === NOTO_WORKSPACE_VERSION
    && typeof value.documentId === 'string' && value.documentId.length > 0 && value.documentId.length <= 256
    && Array.isArray(value.blocks) && value.blocks.length <= MAX_GIT_BLOCKS
    && value.blocks.every((block: unknown) => record(block) && exact(block, ['blockId', 'change', 'head'])
      && isBlockId(block.blockId)
      && ((block.change === 'modified' && isBlockText(block.head)) || (block.change === 'added' && block.head === null)))
    && Array.isArray(value.deleted) && value.deleted.length <= MAX_GIT_BLOCKS
    && value.deleted.every((run: unknown) => record(run) && exact(run, ['beforeBlockId', 'head', 'heads'])
      && (run.beforeBlockId === null || isBlockId(run.beforeBlockId)) && isBlockText(run.head)
      && Array.isArray(run.heads) && run.heads.length > 0 && run.heads.length <= MAX_GIT_BLOCKS
      && run.heads.every(isBlockText));
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
  if (value.exported !== false) return false;
  if (!(WORKSPACE_EXPORT_REFUSALS as readonly string[]).includes(String(value.reason))) return false;
  if (exact(value, ['version', 'exported', 'reason'])) return true;
  return value.reason === 'unsafe-images' && exact(value, ['version', 'exported', 'reason', 'detail'])
    && typeof value.detail === 'string' && value.detail.length > 0 && value.detail.length <= 1000;
}

export const isWorkspaceExportResultV1 = (value: unknown, id: string): value is WorkspaceResultV1<WorkspaceExportReplyV1> =>
  isResult(value, id, isWorkspaceExportReplyV1);
