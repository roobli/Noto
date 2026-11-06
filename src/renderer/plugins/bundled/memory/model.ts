/**
 * What the Related and Activity tabs say, worked out without a window.
 */

import { useEffect, useState } from 'react';
import type { InfoTabHost, NoteMemory, NoteMemoryAnswer } from '../../slots';

/** The person at the window; the vault records their reads under this name. */
const OWNER = 'owner';

export const actorName = (actor: string) => (actor === OWNER ? 'You' : actor);

/** An agent as access.yaml names it; `default` is every agent that brings no key. */
/** An agent's name as the Agents group lists it; `default` is the policy for one that brings no key. */
export const agentName = (name: string) => (name === 'default' ? 'Without a key' : name);

export const times = (count: number) => (count === 1 ? 'once' : count === 2 ? 'twice' : `${count.toLocaleString('en')} times`);

/** Why a note is in Read together, in words: "opened after this 6 times". */
export function togetherWhy(type: string, count: number): string {
  if (/read|open|visit/i.test(type)) return `read together ${times(count)}`;
  if (/change|commit|write/i.test(type)) return `changed together ${times(count)}`;
  if (/link/i.test(type)) return `linked ${times(count)}`;
  return `${type.replace(/[_-]/g, ' ')} ${times(count)}`;
}

/** A title quoted inside a reason, short enough that the reason still fits a line. */
function quoted(title: string, room = 18): string {
  const chars = Array.from(title);
  return `"${chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : title}"`;
}

/**
 * Why the memory offered a note, in the words of the place it is shown. The
 * vault says it the way an agent asks: the "cue" is what was asked, which in
 * About the Same is this note's own title, and in Ask the Vault is the
 * question. The most telling reasons come first (a link, a note read or
 * changed with it, then the words it shares), at most two of them, and a
 * title inside one is cut short.
 */
export function plainWhy(reasons: readonly string[], cue: 'title' | 'question'): string {
  const words = (reason: string): { rank: number; text: string } => {
    const title = /"(.*)"/.exec(reason)?.[1] ?? '';
    if (/^linked from "/.test(reason)) return { rank: 0, text: `linked from ${quoted(title)}` };
    if (/^links to "/.test(reason)) return { rank: 0, text: `links to ${quoted(title)}` };
    if (/^often opened with "/.test(reason)) return { rank: 1, text: `read with ${quoted(title)}` };
    if (/^often changed with "/.test(reason)) return { rank: 1, text: `changed with ${quoted(title)}` };
    if (reason === 'named by the cue') return { rank: 2, text: cue === 'title' ? 'named in this title' : 'named in your question' };
    if (reason === 'the title answers the cue') return { rank: 2, text: cue === 'title' ? 'a title like this one' : 'its title answers it' };
    if (reason === 'matches every word of the cue') return { rank: 3, text: cue === 'title' ? 'has every word of this title' : 'has every word you asked' };
    if (reason === 'matches the cue') return { rank: 4, text: cue === 'title' ? 'shares words with this title' : 'shares words with your question' };
    if (reason === 'the note you are in') return { rank: 5, text: 'the note you are in' };
    return { rank: 2, text: title ? reason.replace(/"(.*)"/, quoted(title)) : reason };
  };
  return reasons.map(words).sort((left, right) => left.rank - right.rank).slice(0, 2).map((item) => item.text).join(' · ');
}

/** How warm a note is, in three steps, for the small meter beside it. */
export function heatLevel(heat: number | undefined): 0 | 1 | 2 | 3 {
  if (heat === undefined || !(heat > 0)) return 0;
  return heat >= 0.66 ? 3 : heat >= 0.33 ? 2 : 1;
}

/** The heat in a sentence, without the words a person would have to look up. */
/** When, in the words a person uses for it: today, yesterday, 3 days ago, Oct 12. */
export function ago(at: string, now = Date.now()): string {
  const then = new Date(at);
  const start = (time: number) => { const day = new Date(time); day.setHours(0, 0, 0, 0); return day.getTime(); };
  const days = Math.round((start(now) - start(then.getTime())) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return `on ${then.toLocaleDateString('en', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/**
 * How warm the note is, in a sentence: what the heat is made of (reads and
 * writes, the recent ones counting most) rather than its number, which
 * means nothing on its own.
 */
export function heatWords(memory: NoteMemory, now = Date.now()): string {
  const { heat } = memory;
  if (heat.reads === 0 && heat.writes === 0) return 'Not read or written since the folder began keeping memory.';
  const parts: string[] = [];
  if (heat.reads > 0) parts.push(`read ${times(heat.reads)}${heat.lastRead ? `, last ${ago(heat.lastRead, now)}` : ''}`);
  if (heat.writes > 0) parts.push(`written ${times(heat.writes)}${heat.lastWrite ? `, last ${ago(heat.lastWrite, now)}` : ''}`);
  const sentence = parts.join('; ');
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
}

/** A note's name from its path, as the tree shows it. */
/** A folder in a line: "42 notes · 3 broken links", or that the memory holds none of it yet. */
export function folderSummary(memory: { readonly notes: number; readonly broken: number }): string {
  if (memory.notes === 0) return 'The memory holds no note here yet.';
  const parts = [`${memory.notes.toLocaleString('en')} ${memory.notes === 1 ? 'note' : 'notes'}`];
  if (memory.broken > 0) parts.push(`${memory.broken.toLocaleString('en')} ${memory.broken === 1 ? 'broken link' : 'broken links'}`);
  return parts.join(' · ');
}

/** How often a note was read, and when last: "read 12 times, last yesterday". */
export function readWhy(note: { readonly reads: number; readonly lastRead: string | null }, now = Date.now()): string {
  return `read ${times(note.reads)}${note.lastRead ? `, last ${ago(note.lastRead, now)}` : ''}`;
}

/**
 * A note's warmth as a share of the warmest's, for its bar. Never quite
 * empty: a note on the list is warm, and a bar of nothing would say it is not.
 */
export function warmthShare(heat: number, warmest: number): number {
  if (!(warmest > 0) || !(heat > 0)) return 0;
  return Math.max(0.04, Math.min(1, heat / warmest));
}

export const nameOf = (rel: string) => rel.split('/').pop()!.replace(/\.(md|markdown|mdown|mkd)$/i, '');

/** The folder-relative path as an absolute one, under the folder the window shows. */
export function absolute(folder: string | null, rel: string): string | null {
  if (!folder) return null;
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${rel.split('/').join(separator)}`;
}

/** Reads per day, as a timeline track marks them: midnight of each day, local time. */
export function readMarks(reads: NoteMemory['reads']): { at: number; value: number; label: string; key: string }[] {
  return reads.map(({ day, count }) => {
    const [year, month, date] = day.split('-').map(Number);
    const at = new Date(year!, (month ?? 1) - 1, date ?? 1).getTime();
    return { at, value: count, label: `${day}: read ${times(count)}`, key: day };
  });
}

/** The memory's answer for the note the pane is about, asked again when the memory says it changed. */
export function useMemory(host: InfoTabHost): { note: string | null; answer: NoteMemoryAnswer | null } {
  const [note, setNote] = useState(() => host.note());
  const [answer, setAnswer] = useState<NoteMemoryAnswer | null>(null);
  useEffect(() => host.onNote(() => setNote(host.note())), [host]);
  useEffect(() => {
    setAnswer(null);
    if (note === null || !host.vault) return undefined;
    let live = true;
    let latest = 0;
    const ask = () => {
      const mine = ++latest;
      host.vault!.about(note).then((next) => {
        if (live && mine === latest) setAnswer(next ?? { state: 'unavailable', memory: null });
      }, () => { if (live && mine === latest) setAnswer({ state: 'unavailable', memory: null }); });
    };
    ask();
    const stop = host.vault.subscribe(ask);
    return () => { live = false; stop(); };
  }, [host, note]);
  return { note, answer };
}
