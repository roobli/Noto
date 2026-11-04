# Writing a plugin for Noto

This is the developer's guide to Noto's plugin model as it stands today. It
says what a plugin is, what it may do, how the bundled ones are put together,
how to write one that someone can install from a folder, GitHub or a
marketplace, and what is not there yet. Read the last section before planning
a plugin.

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
  registerEditorExtension(extension: EditorExtension): Disposer;
  runEditorCommand(name: string): boolean;
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

### Adding to the editor

A plugin that changes how notes are drawn needs more than markdown in and
out. A trusted plugin may register an **editor extension**
(`src/renderer/editor/noto/editor-extensions.ts`): ProseMirror plugins that
every open editor runs, and editor commands they answer to by name.

```ts
interface EditorExtension {
  readonly id: string;                                   // listed in the manifest's editorExtensions
  readonly plugins: () => readonly Plugin[];             // made fresh for each editor
  readonly commands?: Readonly<Record<string, Command>>;
  readonly contextMenu?: (view: EditorView, at: { pos: number | null; element: Element | null })
    => readonly { title: string; command: string }[];
}
```

The id must appear in the manifest's `editorExtensions`, and the manifest
must ask for `editor.decorate`. Every open editor reconfigures when an
extension arrives or leaves, keeping the core plugins' state, and a note
opened later starts with it, so switching the plugin off in Plugin Center
takes its drawing out of every note at once. A plugin that adds to the editor
also starts as soon as it is switched on with a note open, rather than
waiting for the next note. `runEditorCommand(name)` runs one of the
extension's commands, or one of the editor's own, on the note in front, and
needs `editor.transform`.

`contextMenu` adds lines to the editor's right-click menu. On each right
click, main asks the window what the extensions offer at the point clicked and
waits a quarter of a second for the answer; each line names one of the
extension's `commands`, which runs on the note in front when it is chosen.
`at.pos` is the document position under the pointer and `at.element` the
element hit, which is what identifies a widget or anything floated out of the
text. Offer a line only when the click is about something the plugin owns:
the menu is drawn fresh on every click, and most clicks are about nothing a
plugin knows.

This is a trusted surface. A sandboxed plugin's worker has no page to hand a
ProseMirror plugin from, and its manifest must leave `editorExtensions`
empty. The bundled Sidenotes plugin
(`src/renderer/plugins/bundled/sidenotes/`) is the worked example: its
extension draws `<span class="sidenote">` as margin notes, opens the card a
new note is written in from `Cmd+Alt+S` or the right-click menu, and offers
Remove Sidenote when the click is on a note.

Commands appear in the command palette (`Shift+Cmd+P`) while the plugin is active,
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

## Writing a plugin someone can install

A plugin that does not ship with Noto is a folder with two files, named for
the plugin's id: `manifest.json` and `main.js`. The reader installs it from
that folder, from a GitHub repository that holds it, or from the marketplace,
and it lands in `<userData>/plugins/user/<id>/` (on macOS,
`~/Library/Application Support/Noto/plugins/user/`). A folder copied there by
hand works too. Plugins are read when Noto starts, so an install, an update,
a removal or a change of trust takes effect at the next start, which Plugin
Center offers with a Restart button.

The manifest is the one above with `"runtime": "sandboxed"`, the editor's
three capabilities to choose from, and one more optional field,
`description`, a line of at most 200 characters shown before installing. An
id under `dev.lr00rl.noto.` is refused, and so is a hotkey another plugin
already holds; such a folder is listed under Not loaded with the reason.

`main.js` is one self-contained ES module, at most 1 MiB, that exports
`activate(context)`:

```js
export async function activate(ctx) {
  ctx.registerCommand('shout.upper', async () => {
    const markdown = await ctx.port.getMarkdown();
    await ctx.port.replaceMarkdown(markdown.toUpperCase());
    ctx.notice('Shouted.');
  });
  return () => { /* undo anything activate set up */ };
}
```

The context is the `TrustedPluginContext` above, with one difference: by
default the plugin runs **sandboxed**, in a Web Worker of its own, and the
port's methods return promises, because each call is a message to the editor.
Write `await ctx.port.getMarkdown()` and the same code runs in both modes. In
the sandbox the plugin has no page, no app API and no network: the worker's
script is served with the page's policy, `connect-src 'none'` included, set
on the response itself, since a worker takes its policy from its own script
and the session's header hook does not reach one served from this scheme. A
port method its manifest did not declare is refused with
`PLUGIN_CAPABILITY_DENIED`. The note is a way out of its own, since an image
or an embedded page in it is fetched when it is drawn, so `replaceMarkdown`
from a sandboxed plugin is refused with `PLUGIN_NETWORK_DENIED` if the new
text holds a web address the old one did not, however it is written
(character references, backslashes and line breaks inside the address
included). There is no process boundary between the worker and the editor:
it is the model VS Code's web extension host uses, a capability sandbox
rather than a separate process. A command has ten seconds to finish and
activation has ten seconds; a worker that misses either, or sends more than
two hundred messages in a second, is ended. More than forty port calls a
second, or five replacements, are refused.

The reader can **trust a plugin fully** from its page in Plugin Center,
after a warning that names its source and code digest. A fully trusted
plugin is imported into the editor's own page and gets the same context a
bundled plugin gets, with everything the app can do: every note in any open
folder, the settings, and the network. Trust is granted to one sha256 of
`main.js`; change the code, by an update or by hand, and the plugin runs
sandboxed again until it is trusted anew. The code is served only while the
file on disk still has the digest in its address, and from an address that
depends on the trust: a fully trusted plugin's from
`noto://bundle/plugins/<id>/<sha256>/main.js`, the page's own origin, and a
sandboxed plugin's from `noto://plugin-code/<id>/<sha256>/main.js`, which only
the sandbox worker's policy may import from, so a sandboxed plugin's code can
never run in the page itself. A plugin installed or replaced since the last
start is switched off at that start, whatever its id's switch said before.

To publish, push the folder to GitHub. The reader pastes
`https://github.com/owner/repo` (the plugin at the top of the repository) or
`https://github.com/owner/repo/tree/<ref>/<folder>` into Plugin Center, which
fetches the two files from `raw.githubusercontent.com` and shows what the
plugin may do before anything is written.

A **marketplace** is a GitHub repository whose root holds `index.json`.
Plugin Center reads the one named under Settings (`pluginMarketplace`,
`owner/repo`, by default `roobli/noto-plugins`; empty turns it off):

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "local.example.shout",
      "name": "Shout",
      "description": "Upper-cases the note.",
      "version": "1.0.0",
      "repo": "owner/repo",
      "ref": "main",
      "path": "plugins/shout",
      "sha256": "<shasum -a 256 main.js>"
    }
  ]
}
```

`ref` and `path` are optional. With `sha256`, the install is refused unless
the fetched `main.js` has exactly that digest, and the preview says the code
is the code the marketplace vouched for. `manifestSha256` pins
`manifest.json` the same way, which holds the capabilities as well as the
code. `docs/plugin-marketplace/` has a
starting point for such a repository.

## Adding a bundled plugin today

Bundled plugins are compiled into the application and run trusted. To add
one to the build:

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

- **Installs take effect at the next start.** The catalog is read once at
  launch, so Plugin Center restarts Noto rather than loading a plugin live.
  The sandbox is a worker in the editor's process, not a process of its own;
  the separate-process runtime under
  `src/main/plugins/experimental-plugin-runtime-host.ts` is still never
  launched. A plugin is one `main.js`: no archives, no extra files, no
  signing, and no automatic updates.
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
