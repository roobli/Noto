/**
 * Compile / env switch for the `@roobli/md` parse backend.
 *
 * Default is the existing micromark path (`micromark`). Set
 * `NOTO_MARKDOWN_ENGINE=roobli-md` to route `splitBlocks` / `parseSingleBlock`
 * through the thin adapter in `roobli-md-adapter.ts`, flagged
 * `replaceMarkdown` through `PriorSplitCache` → `reparseFromText`, and
 * identity / single-block saves through `@roobli/md` `serializeDocument`.
 *
 * Product builds stay on micromark until parity gates and a broader open-path
 * corpus land; unit tests flip the override explicitly. Flagged open uses
 * deferred structural nodes + renderer range enrich (see
 * docs/performance/open-path-first-cut.md).
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
    if (value === 'roobli-md') return 'roobli-md';
  } catch {
    // Renderer / sandboxed contexts may lack `process`.
  }
  return 'micromark';
}

export function isRoobliMdEngine(): boolean {
  return getMarkdownEngine() === 'roobli-md';
}
