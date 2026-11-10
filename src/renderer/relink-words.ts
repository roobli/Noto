/**
 * What the status line says after a move's links were written again, and
 * after they were taken back: counts in words, and what was left alone.
 */

const count = (value: number, one: string, many = `${one}s`) => `${value.toLocaleString('en')} ${value === 1 ? one : many}`;

export function followedWords(event: { readonly notes: number; readonly links: number; readonly held: number; readonly left: number }): string {
  const parts: string[] = [];
  if (event.notes > 0) parts.push(`Updated ${count(event.links, 'link')} in ${count(event.notes, 'note')}`);
  if (event.held > 0) {
    parts.push(event.notes > 0
      ? `${count(event.held, 'note')} with unsaved edits left as ${event.held === 1 ? 'it is' : 'they are'}`
      : `${count(event.held, 'note')} with unsaved edits still ${event.held === 1 ? 'links' : 'link'} to the old place`);
  }
  if (event.left > 0) parts.push(`${count(event.left, 'note')} changed meanwhile, left as ${event.left === 1 ? 'it is' : 'they are'}`);
  return parts.join('; ');
}

export function undoneWords(reply: { readonly restored: number; readonly kept: number }): string {
  if (reply.restored === 0 && reply.kept === 0) return 'Nothing to put back';
  if (reply.restored === 0) return 'Nothing put back: those notes changed since';
  const done = `Put back the links in ${count(reply.restored, 'note')}`;
  return reply.kept === 0 ? done : `${done}; ${count(reply.kept, 'note')} changed since, kept`;
}
