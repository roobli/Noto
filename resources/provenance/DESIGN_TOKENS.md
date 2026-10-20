# Design token provenance

`src/renderer/styles/_tokens.scss` re-expresses twelve semantic palette values
and three system-font roles taken from the owner's own site theme
(`claude-like-tokens.scss`). It does not import selectors, assets, strings, or
editor aliases from the reference themes.

- Generated reference revision: `76786919683f14ba90bb3dfd279fcc6f4dc57485`
- Underlying light and dark source revision: `9093ded405b8f3066559110732855ae03ea610de`
- Copy date: `2026-08-28`
- Transformation: manually mapped approved values to Noto-owned semantic names
- License: owner-authored source, public license not specified

Public redistribution is authorised. The reference theme is the same owner's
own work, and Noto is published by that owner under AGPL-3.0-only, which
settles the permission this note was waiting on. The twelve values and three
font roles are recorded above so the provenance stays legible even though the
licensing question is closed.

## Amendment, 2026-10-20: contrast

Three values were changed from the source theme so that readable text clears
WCAG AA's 4.5:1 on every surface it sits on, not only on the page. The
decision is cdcd's, from the in-app polish audit; the values were measured
against the paper, panel, raised, overlay and code-fill surfaces.

| Token | Theme | Was | Now | Why |
| --- | --- | --- | --- | --- |
| `--muted` | dark | `#8B8781` | `#97928B` | 4.0–4.1:1 on raised and overlay (quick open, find bar, shortcuts); now 4.65 and up |
| `--code-muted` | light | `#77716A` | `#6E6861` | Code comments at 4.1–4.3:1 on the fence; now 4.66 on code fill |
| `--code-muted` | dark | `#8A847B` | `#979087` | Code comments at 3.9–4.0:1 on the fence; now 4.6 on code fill |

The other source values are unchanged. Text that used to be faded below the
muted tier with `opacity` (the breadcrumb folder, Settings' Remote and
Plugins, the fence's line numbers) now takes a real colour instead, so its
contrast is what it measures.

## Amendment, 2026-10-20: git marks

One token was added, not changed. `--git-changed` colours the tree's mark for
a note that differs from the last commit. atelier's review of the encoding
found the light theme's `--warning` (`#8A642D`) read as the same rust as the
accent bar on the active row beside it, so the mark is shifted toward yellow.
`--warning` itself is unchanged, because it is also set as text, where
`#A86A00` would fall under 4.5:1.

| Token | Theme | Value | Contrast |
| --- | --- | --- | --- |
| `--git-changed` | light | `#A86A00` | 3.94:1 on panel, 3.63:1 on the active row (a mark needs 3:1) |
| `--git-changed` | dark | `#D0A45F` (= `--warning`) | 7.8:1 on panel, 5.6:1 on the active row |

The gutter beside the open note (PR 2) adds no token. Its line uses
`--git-changed` for a changed block and `--success` for a new one, and the
deleted marker uses `--danger`, all on `--paper`:

| Token | Light on paper | Dark on paper |
| --- | --- | --- |
| `--git-changed` | 4.22:1 | 7.26:1 |
| `--success` | 5.69:1 | 7.33:1 |
| `--danger` | 6.35:1 | 6.11:1 |
