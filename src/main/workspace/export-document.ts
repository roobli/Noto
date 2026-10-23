/**
 * Taking a note out of the vault as something other than markdown.
 *
 * Two different jobs wearing one menu. The document formats, Word and the rest,
 * are a conversion of the markdown, and Pandoc does them from the file on disk:
 * the note is the source of truth and converting the source rather than the
 * screen keeps a heading a heading rather than a run of styled text. PDF and
 * HTML are the opposite: what they are for is the document as Noto draws it, so
 * they come from the renderer's own HTML and its own stylesheet.
 *
 * This file owns the Pandoc job and the naming for both. The decisions are pure
 * and tested; the one impure part is the same `execFile` the import uses, with
 * an argument array and no shell. Labels and writers live in shared so the
 * command palette names the same things the menu does.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  EXPORT_TARGETS,
  exportShape,
  needsPandoc,
  type ExportTargetShape,
} from '../../shared/export/targets';
import type { WorkspaceExportKindV1 } from '../../shared/workspace/v1/contracts';
import { vetDocumentImages, type ImagePolicyDeps, type RefusedImage } from './export-images';

export { EXPORT_TARGETS, exportShape, needsPandoc };

/**
 * The same set the IPC carries, not a second list.
 *
 * They were two lists once, and `html-plain` was in one and not the other. The
 * cast that bridged them turned a missing entry into a crash at the moment of
 * export rather than a type error at the moment of writing, which is exactly
 * backwards.
 */
export type ExportTarget = WorkspaceExportKindV1;

export type TargetShape = ExportTargetShape;

/**
 * What the exported file is called, offered in the save dialog.
 *
 * The note's own name with a different extension, which is what every editor
 * suggests and what makes a folder of exports readable next to the notes.
 */
export function suggestedName(notePath: string, target: ExportTarget): string {
  const base = path.basename(notePath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.${exportShape(target).extension}`;
}

/**
 * Reading the note into Pandoc's own document form, so its pictures can be
 * judged before anything is converted.
 *
 * Sandboxed like the conversion: reading markdown needs nothing but the file.
 */
export function readArguments(source: string): string[] {
  return ['--sandbox', '--from', 'gfm', '--to', 'json', '--', source];
}

/**
 * The arguments Pandoc converts with.
 *
 * `--sandbox` always, so Pandoc's readers and writers read nothing but the
 * document they are handed: a picture, an include or anything else a shared
 * note names elsewhere on the disk stays where it is. The pictures the note may
 * carry are already inside that document as data (see `export-images.ts`), so
 * there is no `--resource-path` to look them up by.
 *
 * `--standalone` so the result is a document rather than a fragment, which for
 * every one of these formats is the only useful answer.
 *
 * The filenames go behind the end-of-options marker, so a note called
 * `--version.md` is a note.
 */
export function exportArguments(
  source: string,
  destination: string,
  target: ExportTarget,
): string[] {
  const writer = exportShape(target).writer;
  if (writer === null) throw new Error(`EXPORT_NOT_PANDOC:${target}`);
  return [
    '--sandbox',
    '--from', 'json',
    '--to', writer,
    '--standalone',
    '--output', destination,
    '--', source,
  ];
}

export type ExportRefusal =
  | 'no-document'
  | 'unsaved'
  | 'cancelled'
  | 'no-pandoc'
  | 'failed'
  /** The note names pictures this will not carry; `detail` lists them. */
  | 'unsafe-images'
  /** This Pandoc keeps its templates on disk, where the sandbox cannot read. */
  | 'pandoc-sandbox';

export type ExportOutcome =
  | { readonly exported: true; readonly path: string }
  | { readonly exported: false; readonly reason: ExportRefusal; readonly detail?: string };

export interface ExportDeps {
  /** The note in front, on disk. Null when nothing is open. */
  readonly notePath: string | null;
  /** True when the note has changes that have not been written. */
  readonly dirty: boolean;
  /** Where to write it, or null when the reader dismissed the dialog. */
  readonly choose: (suggested: string) => Promise<string | null>;
  readonly findPandoc: () => Promise<string | null>;
  readonly run: (binary: string, args: readonly string[]) => Promise<string>;
  /** The picture policy, less the note's folder, which comes from `notePath`. */
  readonly images: Omit<ImagePolicyDeps, 'noteDirectory'>;
}

/** The longest list of refused pictures put in front of the reader. */
const REFUSED_DETAIL_LIMIT = 600;

function describeRefused(refused: readonly RefusedImage[]): string {
  const listed = refused.map((image) => `${image.source} (${image.why})`).join(', ');
  return listed.length > REFUSED_DETAIL_LIMIT ? `${listed.slice(0, REFUSED_DETAIL_LIMIT)}…` : listed;
}

/**
 * Export through Pandoc.
 *
 * Refused while the note has unsaved changes, because this converts the file
 * rather than the screen: exporting would quietly produce a document of the
 * last saved version while the reader was looking at a newer one, which is the
 * kind of wrong that is only noticed after it has been sent to somebody.
 *
 * Two runs: the note is read into Pandoc's document form, its pictures are
 * judged and the allowed ones written in as data, and that document is what is
 * converted. A note naming a picture the policy refuses is not exported at all,
 * and the refusal lists what it named.
 */
export async function exportThroughPandoc(
  target: ExportTarget,
  deps: ExportDeps,
): Promise<ExportOutcome> {
  if (!deps.notePath) return { exported: false, reason: 'no-document' };
  if (deps.dirty) return { exported: false, reason: 'unsaved' };

  const destination = await deps.choose(suggestedName(deps.notePath, target));
  if (destination === null) return { exported: false, reason: 'cancelled' };

  const binary = await deps.findPandoc();
  if (binary === null) return { exported: false, reason: 'no-pandoc' };

  let staging: string | null = null;
  try {
    const document: unknown = JSON.parse(await deps.run(binary, readArguments(deps.notePath)));
    const refused = await vetDocumentImages(document, {
      ...deps.images,
      noteDirectory: path.dirname(deps.notePath),
    });
    if (refused.length > 0) {
      return { exported: false, reason: 'unsafe-images', detail: describeRefused(refused) };
    }
    staging = await mkdtemp(path.join(tmpdir(), 'noto-export-'));
    const staged = path.join(staging, 'note.json');
    await writeFile(staged, JSON.stringify(document), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await deps.run(binary, exportArguments(staged, destination, target));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (/could not find data file/i.test(message)) {
      return { exported: false, reason: 'pandoc-sandbox', detail: message.slice(0, 400) };
    }
    return {
      exported: false,
      reason: 'failed',
      detail: cause instanceof Error ? message.slice(0, 400) : undefined,
    };
  } finally {
    if (staging !== null) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
  return { exported: true, path: destination };
}
