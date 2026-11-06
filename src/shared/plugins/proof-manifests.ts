import type { PluginManifest } from './manifest';

export const rendererProofManifest = {
  schemaVersion: 2,
  id: 'dev.lr00rl.noto.renderer-proof',
  name: 'Semantic Focus',
  version: '1.0.0',
  runtime: 'trusted-renderer',
  activation: {
    startup: true,
    events: ['editor.ready'],
    hotkeys: ['Mod+Shift+J'],
  },
  capabilities: ['editor.decorate'],
  lifecycle: ['activate', 'deactivate'],
  commands: [{ id: 'semantic-focus.toggle', title: 'Toggle semantic focus' }],
  settings: [{ key: 'focusEnabled', type: 'boolean', default: true }],
  hotkeys: [{ command: 'semantic-focus.toggle', keys: 'Mod+Shift+J' }],
  editorExtensions: ['active-semantic-focus'],
  uiExtensions: ['semantic-focus-status'],
} satisfies PluginManifest;

/**
 * Trusted first-party plugins, ported from the owner's Typora plugin set.
 *
 * They declare `editor.transform` because they rewrite the whole document.
 * Neither activates on startup: a transform plugin that ran before the user
 * asked would edit their file unprompted.
 */
export const titleShiftManifest = {
  schemaVersion: 2,
  id: 'dev.lr00rl.noto.title-shift',
  name: 'Title Shift',
  version: '1.0.0',
  runtime: 'trusted-renderer',
  activation: {
    startup: false,
    events: ['editor.ready'],
    hotkeys: ['Mod+Shift+ArrowUp', 'Mod+Shift+ArrowDown'],
  },
  capabilities: ['editor.read', 'editor.transform'],
  lifecycle: ['activate', 'deactivate'],
  commands: [
    { id: 'title-shift.promote', title: 'Headings: promote a level' },
    { id: 'title-shift.demote', title: 'Headings: demote a level' },
  ],
  settings: [],
  hotkeys: [
    { command: 'title-shift.promote', keys: 'Mod+Shift+ArrowUp' },
    { command: 'title-shift.demote', keys: 'Mod+Shift+ArrowDown' },
  ],
  editorExtensions: [],
  uiExtensions: [],
} satisfies PluginManifest;

/**
 * Margin notes from `<span class="sidenote">`, the author's Typora plugin as a
 * bundled one. On by default, because notes written for that plugin read
 * wrong without it; turned off, the tags stay in the text as source.
 */
export const sidenotesManifest = {
  schemaVersion: 2,
  id: 'dev.lr00rl.noto.sidenotes',
  name: 'Sidenotes',
  version: '1.0.0',
  runtime: 'trusted-renderer',
  activation: {
    startup: false,
    events: ['editor.ready'],
    hotkeys: ['Mod+Alt+S'],
  },
  capabilities: ['editor.read', 'editor.transform', 'editor.decorate'],
  lifecycle: ['activate', 'deactivate'],
  commands: [
    { id: 'sidenotes.insert', title: 'Sidenote: add a note to the selected words' },
    { id: 'sidenotes.remove', title: 'Sidenote: remove the note at the caret' },
  ],
  settings: [],
  hotkeys: [{ command: 'sidenotes.insert', keys: 'Mod+Alt+S' }],
  editorExtensions: ['sidenotes'],
  uiExtensions: [],
} satisfies PluginManifest;

/**
 * The notes changed since the last commit, as a page in the rail. Its whole
 * interface is that page, so it never takes an editor lease.
 */
export const changesManifest = {
  schemaVersion: 2,
  id: 'dev.lr00rl.noto.changes',
  name: 'Changes',
  version: '1.0.0',
  runtime: 'trusted-renderer',
  activation: {
    startup: false,
    events: [],
    hotkeys: [],
  },
  capabilities: ['git.read'],
  lifecycle: ['activate', 'deactivate'],
  commands: [],
  settings: [],
  hotkeys: [],
  editorExtensions: [],
  uiExtensions: ['rail:changes'],
} satisfies PluginManifest;

export const historyManifest = {
  schemaVersion: 2,
  id: 'dev.lr00rl.noto.history',
  name: 'History',
  version: '1.0.0',
  runtime: 'trusted-renderer',
  activation: {
    startup: false,
    events: [],
    hotkeys: [],
  },
  capabilities: ['git.read', 'editor.read', 'editor.transform', 'vault.read'],
  lifecycle: ['activate', 'deactivate'],
  commands: [],
  settings: [],
  hotkeys: [],
  editorExtensions: [],
  uiExtensions: ['info:history', 'info:properties', 'track:commits'],
} satisfies PluginManifest;

export const memoryManifest = {
  schemaVersion: 2,
  id: 'dev.lr00rl.noto.memory',
  name: 'Memory',
  version: '1.0.0',
  runtime: 'trusted-renderer',
  activation: {
    startup: false,
    events: ['editor.ready'],
    hotkeys: [],
  },
  capabilities: ['vault.read', 'vault.review'],
  lifecycle: ['activate', 'deactivate'],
  commands: [{ id: 'memory.ask', title: 'Memory: ask the folder a question' }],
  settings: [],
  hotkeys: [],
  editorExtensions: [],
  uiExtensions: ['info:related', 'info:activity', 'track:reads', 'rail:review', 'marks:links'],
} satisfies PluginManifest;

/** Bundled plugins that start switched on for a reader who never touched them. */
export const BUNDLED_ON_BY_DEFAULT: ReadonlySet<string> = new Set([sidenotesManifest.id, changesManifest.id, historyManifest.id, memoryManifest.id]);

export const markdownPaddingManifest = {
  schemaVersion: 2,
  id: 'dev.lr00rl.noto.md-padding',
  name: 'Markdown Padding',
  version: '1.0.0',
  runtime: 'trusted-renderer',
  activation: {
    startup: false,
    events: ['editor.ready'],
    hotkeys: ['Mod+Shift+Space'],
  },
  capabilities: ['editor.read', 'editor.transform'],
  lifecycle: ['activate', 'deactivate'],
  commands: [{ id: 'md-padding.format', title: 'Format: add CJK spacing' }],
  settings: [],
  hotkeys: [{ command: 'md-padding.format', keys: 'Mod+Shift+Space' }],
  editorExtensions: [],
  uiExtensions: [],
} satisfies PluginManifest;

export const filesystemProofManifest = {
  schemaVersion: 2,
  id: 'dev.lr00rl.noto.filesystem-proof',
  name: 'Fixture Reader',
  version: '1.0.0',
  runtime: 'isolated-service',
  activation: {
    startup: false,
    events: ['document.opened'],
    hotkeys: [],
  },
  capabilities: ['filesystem.read'],
  lifecycle: ['start', 'stop'],
  commands: [{ id: 'fixture-reader.read', title: 'Read granted fixture' }],
  settings: [],
  hotkeys: [],
  editorExtensions: [],
  uiExtensions: ['fixture-reader-status'],
} satisfies PluginManifest;
