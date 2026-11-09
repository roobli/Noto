/**
 * What Review says, worked out without a window: what a write did, in one
 * sentence that names what it left alone and why, and the line that says
 * where a proposal came from.
 */

import type { ReviewAnswer, ReviewProposal } from '../../slots';
import { ago, nameOf } from './model';

type Value<K extends 'accept' | 'link' | 'undo'> = NonNullable<ReviewAnswer<K>['value']>;

const notes = (count: number) => `${count.toLocaleString('en')} ${count === 1 ? 'note' : 'notes'}`;

/** The names of a few notes, and how many more. */
function named(paths: readonly string[], shown = 2): string {
  const names = paths.slice(0, shown).map(nameOf).join(', ');
  return paths.length > shown ? `${names} and ${paths.length - shown} more` : names;
}

export function acceptWords(value: Value<'accept'>): string {
  if (value.busy.length > 0) return `Nothing taken in: save ${named(value.busy)} first, which ${value.busy.length === 1 ? 'has' : 'have'} unsaved edits.`;
  const parts: string[] = [];
  if (value.applied.length > 0) parts.push(`Took in the changes to ${notes(value.applied.length)}`);
  if (value.unchanged.length > 0) parts.push(`${notes(value.unchanged.length)} already had ${value.unchanged.length === 1 ? 'it' : 'them'}`);
  if (value.conflicts.length > 0) {
    parts.push(`${named(value.conflicts)} changed since in a way that does not merge, so the proposal stays for ${value.conflicts.length === 1 ? 'it' : 'them'}`);
  }
  return parts.length === 0 ? 'The proposal had nothing left to take in.' : `${parts.join('; ')}.`;
}

/** What linking did; `asked` is how many suggestions were sent. */
export function linkWords(value: Value<'link'>, asked: number): string {
  const parts: string[] = [];
  if (value.linked.length > 0) parts.push(asked === 1 && value.linked.length === 1 ? 'Linked' : `Linked ${value.linked.length.toLocaleString('en')} of ${asked.toLocaleString('en')}`);
  if (value.outdated.length > 0) parts.push(`${value.outdated.length.toLocaleString('en')} had changed since and ${value.outdated.length === 1 ? 'is' : 'are'} left to be suggested again`);
  if (value.busy.length > 0) parts.push(`${value.busy.length.toLocaleString('en')} ${value.busy.length === 1 ? 'is in a note' : 'are in notes'} with unsaved edits`);
  return parts.length === 0 ? 'Nothing was linked.' : `${parts.join('; ')}.`;
}

export function undoWords(value: ReviewAnswer<'undo'>['value']): string {
  if (value === null) return 'There is nothing to take back.';
  const parts: string[] = [];
  if (value.restored.length > 0) parts.push(`Put ${notes(value.restored.length)} back as ${value.restored.length === 1 ? 'it was' : 'they were'}`);
  if (value.changed.length > 0) parts.push(`left ${named(value.changed)}, written to since`);
  if (value.busy.length > 0) parts.push(`left ${named(value.busy)}, with unsaved edits`);
  const sentence = parts.join('; ');
  return sentence ? `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.` : 'Nothing was put back.';
}

/** Who proposed it and when, and which file of it is shown. */
export function proposalDetail(proposal: ReviewProposal, index: number, now = Date.now()): string {
  const file = proposal.files[index];
  const where = proposal.files.length > 1 ? ` · file ${index + 1} of ${proposal.files.length}` : '';
  return `${proposal.author} · ${ago(proposal.time, now)}${where}${file ? `: ${file.path}` : ''}`;
}

/** What a proposal does to a file, in a word. */
export function fileChange(status: string): string {
  if (status.startsWith('A')) return 'new';
  if (status.startsWith('D')) return 'deleted';
  return 'changed';
}
