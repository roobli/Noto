# Writing a plugin for Noto

This is the developer's guide to Noto's plugin model as it stands today. It
says what a plugin is, what it may do, how the four bundled ones are put
together, and where the line currently falls between what ships and what is
built but not yet opened. Read the last section before planning a plugin that
lives outside the repository.

## The model in one paragraph

A plugin is a manifest plus code. The manifest declares everything the plugin
will ever ask for: which runtime it runs in, which capabilities it needs,
which commands, hotkeys and settings it contributes. Nothing is ambient. A
plugin that did not declare `editor.transform` cannot replace the document
even if its code tries; a service plugin reads only the folder it was granted,
and the grant is revocable. The lifecycle is owned by the main process, which
keeps every plugin's enabled state and settings on disk and drives activation
per generation with a lease and an abort signal, so a plugin that misbehaves
is torn down without taking the editor with it.

## Two runtimes

`trusted-renderer` plugins run inside the editor's own renderer process. They
see the document through a small port and contribute commands, hotkeys and
settings. This is the runtime for anything that transforms or decorates text.
Three of the bundled plugins are this kind.

`isolated-service` plugins run in a separate utility process with no access to
the document at all. They are for work that needs the filesystem, and they get
it one grant at a time: a folder chosen by the reader, brokered by main,
denied everywhere else. Fixture Reader is the bundled example.

## The manifest

`manifest.json`, schema version 2. Every field is required and no other field
is allowed; the validator is `validatePluginManifest` in
`src/shared/plugins/manifest.ts` and the unit tests in
`tests/unit/plugin-manifest.test.ts` are the executable specification.

```json
{
  "schemaVersion": 2,
  "id": "dev.lr00rl.noto.title-shift",
  "name": "Title Shift",
  "version": "1.0.0",
  "runtime": "trusted-renderer",
  "activation": { "startup": false, "events": ["editor.ready"],
                  "hotkeys": ["Mod+Shift+ArrowUp", "Mod+Shift+ArrowDown"] },
  "capabilities": ["editor.read", "editor.transform"],
  "lifecycle": ["activate", "deactivate"],
  "commands": [
    { "id": "title-shift.promote", "title": "Headings: promote a level" },
    { "id": "title-shift.demote", "title": "Headings: demote a level" }
  ],
  "settings": [],
  "hotkeys": [
    { "command": "title-shift.promote", "keys": "Mod+Shift+ArrowUp" },
    { "command": "title-shift.demote", "keys": "Mod+Shift+ArrowDown" }
  ],
  "editorExtensions": [],
  "uiExtensions": []
}
```

The rules the validator enforces:

- `id` is dotted lowercase; `name` is at most 80 characters; `version` is a
  bounded semver.
- Capabilities are scoped to the runtime. A renderer plugin may declare
  `editor.read`, `editor.decorate` and `editor.transform`; a service plugin
  may declare only `filesystem.read`.
- `lifecycle` is exactly `["activate", "deactivate"]` for a renderer plugin
  and `["start", "stop"]` for a service.
- Every hotkey names a declared command, every activation hotkey is one of the
  declared hotkeys, and two plugins in one catalog may not claim the same
  chord.
- A hotkey is `Mod`, `Ctrl`, `Alt` and `Shift` in any combination plus one
  key: a letter, a digit, or a named key such as `ArrowUp`. `Mod` is Command
  on macOS and Control elsewhere.
- Settings are booleans with a default. That is the whole settings type
  system today; a plugin that needs a string or a number does not yet have a
  place to keep it.

Every array is bounded at 32 unique entries and a catalog at 64 plugins.

## What a renderer plugin can call

The code side of a trusted renderer plugin is a class with one method,
`activate`, taking a context and returning a disposer. The context is the
whole API:

```ts
interface TrustedPluginContext {
  readonly pluginId: string;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly signal: AbortSignal;
  readonly port: NotoEditorPort;
  registerCommand(id: string, execute: () => void | Promise<void>): Disposer;
  registerHotkey(keys: string, execute: () => void | Promise<void>): Disposer;
  registerDisposer(disposer: Disposer): void;
  notice(message: string): void;
}
```

The port is the document:

```ts
interface NotoEditorPort {
  getMarkdown(): string;                       // needs editor.read
  replaceMarkdown(markdown: string): boolean;  // needs editor.transform
  setSemanticFocus(enabled: boolean): void;    // needs editor.decorate
}
```

A call the manifest did not declare is refused at the host, not at the port,
so the failure is a lifecycle fault against the plugin rather than an
exception in the editor. Registering a command or hotkey that the manifest
does not declare is refused the same way, as is registering one twice.

`replaceMarkdown` replaces the whole document through the editor's transaction
path, so it is one undo step and the save stays byte-exact for every block the
replacement did not touch. A transform that works on the whole text and hands
it back is the intended shape; Title Shift and Markdown Padding both do
exactly this, and their pure transforms in
`src/renderer/plugins/bundled/transforms.ts` are unit-tested on their own.

Commands appear in the command palette (`Cmd+K`) while the plugin is active,
under the title the manifest gives them. Hotkeys are dispatched by the shell
and reach the plugin through the registry, so they work wherever focus is.

## Lifecycle, as the reader sees it

A freshly discovered plugin is off. Enabling it in Settings records the
intent and leaves it waiting for an editor; activating it, or the editor's
own `editor.ready` event, starts a generation. Disabling deactivates and
forgets. A plugin that throws during activation is marked failed and can be
retried or disabled from the same place, and its last failure is shown under
Diagnostics.

Settings shows this as one index of plugins and one detail at a time. The
dot beside a name is the state: filled when running, a ring when enabled and
waiting, faint when off, red when failed.

## Adding a bundled plugin today

Plugins ship inside the application. There is no plugins folder to drop a
file into yet; see the last section. To add one to the build:

1. Put a `manifest.json` in `resources/plugins/<id>/`. Main discovers it at
   launch from that folder, and refuses a manifest that is not a regular file,
   is a symlink, or is larger than 256 KB.
2. Mirror the manifest as a TypeScript constant in
   `src/shared/plugins/proof-manifests.ts`. The shell reads names and command
   titles from there, and the unit tests check the two stay identical.
3. Write the plugin class against `TrustedPluginContext` in
   `src/renderer/plugins/bundled/index.ts`, and register it in
   `createRendererPluginHosts` in `src/renderer/plugins/bundled/hosts.ts`.
   That is the one wiring step: the registry routes leases to hosts by id.
4. Add the description the reader sees to `pluginDescriptions` in
   `src/renderer/plugins/PluginCenter.tsx`. The lifecycle layer can only say
   what a plugin may touch, which is the same sentence for every renderer
   plugin; the description should say what it does.
5. Write a unit test for the transform and, if it changes what the reader
   sees, a packaged end-to-end test in `tests/e2e`.

A service plugin needs, in addition, a host implementing the service protocol
in `src/shared/plugins/protocol.ts` and an entry for the utility process; read
`src/service/fs-service.ts` and `src/main/plugins/service-host.ts` together.

## Where the line is today

Be clear-eyed about what is not yet there, because it changes what you should
build:

- **No third-party loading.** Plugin code is compiled into the application
  and discovered only from the bundled resources folder. A sandboxed runtime
  for untrusted code exists, with its own origin, session, preload and content
  security policy under `src/main/protocol/register-experimental-plugin-protocol.ts`
  and `src/main/plugins/experimental-plugin-runtime-host.ts`, but the
  application never launches it. Opening it, with a user plugins folder, a
  package digest, and an install flow, is the next step on this road; until
  then a plugin is a pull request.
- **Activation is on `editor.ready` only.** When a document's editor comes up
  and an enabled plugin is waiting, the shell raises `editor.ready` and the
  plugin activates, so a plugin enabled yesterday is running when a note
  opens today. `activation.startup` is validated and stored but nothing
  fires it, and no other event is raised.
- **Settings are booleans.** See above.
- **`notice` is a status line message.** It shows in the status bar for a
  couple of seconds, attributed to the plugin in the lifecycle counters, and
  that is all it can do: no actions, no persistence.
- **UI extensions are declared and unconsumed.** Nothing reads
  `uiExtensions` yet.

Each of these is a known gap rather than a design choice, and the order above
is the order they are likely to close.

## Reading the examples

`Semantic Focus` is the smallest complete renderer plugin: a setting, a
decoration, a command and a hotkey, in
`src/renderer/plugins/renderer-proof/plugin.ts`. `Fixture Reader` is the
service example: it asks for a folder grant, reads inside it, and can be made
to prove that a path outside it is refused. Both are kept in the build as
examples rather than features, and Settings says so under their names.
