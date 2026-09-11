import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings/v1/contracts';
import { coerceSettings, isSettingsWriteRequestV1 } from '../../src/shared/settings/v1/validate';
import { SettingsStore } from '../../src/main/workspace/settings-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeIn(contents?: string): Promise<{ store: SettingsStore; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noto-settings-'));
  roots.push(root);
  const file = path.join(root, 'settings.json');
  if (contents !== undefined) await writeFile(file, contents, 'utf8');
  return { store: new SettingsStore(file), file };
}

describe('reading settings', () => {
  it('starts from the defaults when there is no file', async () => {
    const { store } = await storeIn();
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps Links off the default path', () => {
    expect(DEFAULT_SETTINGS.railLinks).toBe(false);
  });

  it('keeps the readable fields when the file is partly corrupt', async () => {
    // A hand edited file with one good value and two bad ones must not cost the
    // user every preference.
    expect(coerceSettings({ theme: 'dark', measure: 'enormous', spellCheck: 'yes' })).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
    });
  });

  it('falls back completely when the file is not an object', async () => {
    const { store } = await storeIn('"not an object"');
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back when the file is not valid JSON', async () => {
    const { store } = await storeIn('{ broken');
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('writing settings', () => {
  it('applies a patch and leaves the other settings alone', async () => {
    const { store } = await storeIn();
    const updated = await store.update({ theme: 'dark' });
    expect(updated.theme).toBe('dark');
    expect(updated.widthMode).toBe(DEFAULT_SETTINGS.widthMode);
    expect(updated.smartQuotes).toBe(DEFAULT_SETTINGS.smartQuotes);
  });

  it('persists across a restart', async () => {
    const { store, file } = await storeIn();
    await store.update({ theme: 'dark', widthMode: 'wide', fontSize: 20 });

    const reopened = new SettingsStore(file);
    expect(await reopened.load()).toMatchObject({ theme: 'dark', widthMode: 'wide', fontSize: 20 });
  });

  it('writes readable json', async () => {
    const { store, file } = await storeIn();
    await store.update({ spellCheck: false });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ spellCheck: false });
  });
});

describe('validating a write from the renderer', () => {
  const base = { version: 1 as const, requestId: 'settings-1' };

  it('accepts a known key with the right type', () => {
    expect(isSettingsWriteRequestV1({ ...base, patch: { theme: 'dark' } })).toBe(true);
    expect(isSettingsWriteRequestV1({ ...base, patch: { spellCheck: false } })).toBe(true);
  });

  it('rejects an unknown key rather than dropping it silently', () => {
    expect(isSettingsWriteRequestV1({ ...base, patch: { nonsense: true } })).toBe(false);
  });

  it('rejects a known key with the wrong type or an invalid value', () => {
    expect(isSettingsWriteRequestV1({ ...base, patch: { theme: 'chartreuse' } })).toBe(false);
    expect(isSettingsWriteRequestV1({ ...base, patch: { spellCheck: 'yes' } })).toBe(false);
  });

  it('rejects an empty patch, which would be a write that changes nothing', () => {
    expect(isSettingsWriteRequestV1({ ...base, patch: {} })).toBe(false);
  });
});

describe('the three substitutions that used to be one switch', () => {
  it('take the old switch as their answer when a file only carries that', () => {
    // A file written before the split carries the old key and none of the new.
    const { smartQuotes, smartDashes, smartEllipsis, ...rest } = DEFAULT_SETTINGS;
    void smartQuotes; void smartDashes; void smartEllipsis;
    const older = coerceSettings({ ...rest, smartTypography: false });
    expect(older.smartQuotes).toBe(false);
    expect(older.smartDashes).toBe(false);
    expect(older.smartEllipsis).toBe(false);
  });

  it('keep their own answers once they have them', () => {
    const mixed = coerceSettings({
      ...DEFAULT_SETTINGS, smartTypography: false,
      smartQuotes: false, smartDashes: true, smartEllipsis: true,
    });
    expect(mixed.smartQuotes).toBe(false);
    expect(mixed.smartDashes).toBe(true);
    expect(mixed.smartEllipsis).toBe(true);
  });
});

describe('image settings', () => {
  it('defaults to an assets folder beside the note, which is what keeps a note portable', () => {
    expect(DEFAULT_SETTINGS.imageDestination).toBe('assets');
    expect(DEFAULT_SETTINGS.imageEscapeUrl).toBe(true);
  });

  it('falls back when the stored destination is not one of the four', () => {
    expect(coerceSettings({ imageDestination: 'ipic' }).imageDestination).toBe('assets');
    expect(coerceSettings({ imageDestination: 'note-assets' }).imageDestination).toBe('note-assets');
  });

  it('refuses a custom folder that climbs out of the note folder', () => {
    expect(coerceSettings({ imageCustomFolder: '../../Desktop' }).imageCustomFolder)
      .toBe(DEFAULT_SETTINGS.imageCustomFolder);
    expect(coerceSettings({ imageCustomFolder: './pics/screens' }).imageCustomFolder).toBe('./pics/screens');
  });

  it('refuses a folder carrying a newline, which is how a path smuggles a second argument', () => {
    expect(coerceSettings({ imageCustomFolder: './pics\nrm -rf' }).imageCustomFolder)
      .toBe(DEFAULT_SETTINGS.imageCustomFolder);
  });

  it('rejects a write of a destination it does not know rather than storing something else', () => {
    // `upload` is a real choice now, Typora's own; `ipic` is its internal name
    // for the same thing and not one this app defines.
    expect(isSettingsWriteRequestV1({
      version: 1, requestId: 'a', patch: { imageDestination: 'ipic' },
    })).toBe(false);
    expect(isSettingsWriteRequestV1({
      version: 1, requestId: 'a', patch: { imageDestination: 'upload' },
    })).toBe(true);
    expect(isSettingsWriteRequestV1({
      version: 1, requestId: 'a', patch: { imageDestination: 'custom' },
    })).toBe(true);
  });

  it('rejects a write of a folder that climbs out', () => {
    expect(isSettingsWriteRequestV1({
      version: 1, requestId: 'a', patch: { imageCustomFolder: '../out' },
    })).toBe(false);
  });
});

describe('the document font', () => {
  it('is one of the three faces, and anything else falls back to the serif', () => {
    expect(coerceSettings({ proseFace: 'mono' }).proseFace).toBe('mono');
    expect(coerceSettings({ proseFace: 'Comic Sans' }).proseFace).toBe('serif');
    expect(coerceSettings({}).proseFace).toBe('serif');
  });

  it('is written only as a face the app knows', () => {
    expect(isSettingsWriteRequestV1({ version: 1, requestId: 'a', patch: { proseFace: 'sans' } })).toBe(true);
    expect(isSettingsWriteRequestV1({ version: 1, requestId: 'a', patch: { proseFace: 'Songti SC' } })).toBe(false);
  });
});
