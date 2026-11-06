/**
 * Which folders may run the scripts in their memory.
 *
 * A folder's `.noto/scripts/*.mjs` are code: the vault imports them when it
 * opens, to sort notes into kinds or read a field the folder writes its own
 * way, and an import can do anything a program can. A folder that came from
 * somewhere else (a clone, a download) must not run them because Note Info
 * happened to be open, so main asks once per folder, naming the scripts, and
 * remembers the answer here, in Noto's own data rather than in the folder,
 * where a folder could grant itself trust. A folder Noto made memory for is
 * trusted, since nothing in it came from elsewhere.
 *
 * The person's own word is the only way in: the window asks main to ask, and
 * main shows the question itself, so a plugin cannot answer it.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** The scripts the vault would import, as it finds them (`@roobli/vault`'s `loadScripts`). */
export function memoryScripts(root: string): string[] {
  try {
    return readdirSync(path.join(root, '.noto', 'scripts')).filter((name) => /\.m?js$/.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * Folders, by their real paths, kept in a file of Noto's own data: what the
 * person said of each, where no folder can say it of itself. A list that
 * cannot be saved is kept for this launch.
 */
export class FolderList {
  private readonly folders: Set<string>;

  constructor(
    private readonly file: string,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () => {},
    /** Logged when the file cannot be written. */
    private readonly unsaved = 'folder_list_not_saved',
  ) {
    this.folders = new Set(this.read());
  }

  has(root: string): boolean {
    return this.folders.has(root);
  }

  add(root: string): void {
    if (this.folders.has(root)) return;
    this.folders.add(root);
    this.save();
  }

  delete(root: string): void {
    if (this.folders.delete(root)) this.save();
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ version: 1, folders: [...this.folders].sort() }, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.log(this.unsaved, { reason: (error as Error).message });
    }
  }

  private read(): string[] {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; folders?: unknown };
      return value.version === 1 && Array.isArray(value.folders)
        ? value.folders.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item))
        : [];
    } catch {
      return [];
    }
  }
}

export class MemoryTrust {
  private readonly allowed: FolderList;

  constructor(file: string, log: (event: string, fields: Record<string, unknown>) => void = () => {}) {
    // Kept for this launch when it cannot be saved; the question comes again next time.
    this.allowed = new FolderList(file, log, 'memory_trust_not_saved');
  }

  /** Whether the memory of the folder at `root` (a real path) may be opened: it runs no scripts, or was allowed to. */
  mayOpen(root: string): boolean {
    return this.allowed.has(root) || memoryScripts(root).length === 0;
  }

  trust(root: string): void {
    this.allowed.add(root);
  }
}
