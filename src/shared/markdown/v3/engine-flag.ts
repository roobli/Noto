/**
 * Compile / env switch for the `@roobli/md` parse backend.
 *
 * Product default is `@roobli/md` (`roobli-md`). Set
 * `NOTO_MARKDOWN_ENGINE=micromark` to force the legacy micromark path.
 * Routes `splitBlocks` / `parseSingleBlock` through `roobli-md-adapter.ts`,
 * `replaceMarkdown` through `PriorSplitCache` → `reparseFromText`, and
 * identity / single-/multi-block saves through `@roobli/md` `serializeDocument`.
 *
 * Open uses deferred structural nodes + renderer range enrich (see
 * docs/performance/open-path-first-cut.md). Intentional leftover on the
 * engine path: thirty-eight+ nested marks (`MAX_MARK_NEST`=37).
 */

export type MarkdownEngineId = 'micromark' | 'roobli-md';

let testOverride: MarkdownEngineId | null = null;

/** Force an engine in unit tests; pass `null` to restore env/default. */
export function setMarkdownEngineForTests(engine: MarkdownEngineId | null): void {
  testOverride = engine;
}

export function getMarkdownEngine(): MarkdownEngineId {
  if (testOverride !== null) return testOverride;
  try {
    const value = typeof process !== 'undefined' ? process.env?.NOTO_MARKDOWN_ENGINE : undefined;
    if (value === 'micromark') return 'micromark';
    if (value === 'roobli-md') return 'roobli-md';
  } catch {
    // Renderer / sandboxed contexts may lack `process`.
  }
  return 'roobli-md';
}

export function isRoobliMdEngine(): boolean {
  return getMarkdownEngine() === 'roobli-md';
}
