# Large documents

## Typing on a very large document, measured 2026-09-02

The corpus files under `out/bench/corpus` are 66KB, 525KB, 2MB and 8MB. The
author's own vault has three notes over a megabyte, the largest 2.9MB, and
thirty-three over 200KB.

| document | blocks | opens in | median keystroke |
| --- | --- | --- | --- |
| medium, 525KB | 2,742 | 1.1s | 21ms |
| large, 2MB | 10,982 | 3.9s | 113ms |
| huge, 8MB | 43,970 | 24s | 1.4s |

Where the time goes. Every decoration plugin's share of a keystroke was timed
on the 8MB document by applying transactions to a state with each plugin alone:
alerts, Typora's inline marks, the active block and the syntax highlighter
together cost 14ms per twenty keystrokes, or 0.7ms each. The remaining 1.4s is
the view: ProseMirror reconciling a document of forty-four thousand top level
nodes. Nothing in the editor's own logic accounts for it.

One real fault was found and fixed by that measurement. The alert plugin
rebuilt its whole decoration set on every keystroke, which cost 11ms a letter
in the state and far more in the view, since a wholly new set gives ProseMirror
nothing to compare and it revisits every block. It is incremental now, like the
highlighter and the marks: the set is mapped through the transaction and only
the blocks the change or the selection touched are rescanned. On the 8MB
document the 95th percentile keystroke fell from 5.2s to 1.5s.

The view layer was then tested by removing plugins from a real build rather
than by inference. With the alert plugin, the inline marks and the active
block all taken out, the 2MB document still took 113ms a keystroke, the same
as with them. No decoration this editor draws accounts for the cost: it is
ProseMirror reconciling a document whose top level holds eleven thousand
children, and shortening that would mean rendering only what is on screen,
which is a different architecture rather than a tuning.

What is left is the view layer, and it is the honest limit of this design at
this size. A 2MB note, which is larger than all but three notes in the vault,
takes 113ms a keystroke: perceptible, and short of where it should be.

## Selective paint deferral, 2026-09-10

The view cost above is mostly the engine laying out every top level block on
each keystroke. `contain: layout` alone took about thirteen percent off that.
Blanket `content-visibility: auto` took about forty percent off a keystroke on
the two megabyte corpus and broke markdown input rules, because style
containment on the block under the caret stops ProseMirror reading the DOM back
after a keystroke.

The editor now keeps that paint deferral for every top level block that is not
near the selection, and forces the selection's neighbourhood fully painted.
Input rules keep working; off-screen blocks are not laid out. Reproduce the
layout split with `scripts/bench/profile-typing.mjs` against a packaged build.

## Stubbing scroller, 2026-09-10

Paint deferral still left every top level block in the DOM. The next step is
now landed as a measured vertical slice rather than more CSS.

`viewport-stub.ts` replaces far-off top level blocks with height placeholders
once a document has at least 3,000 top level blocks (between the medium and
large corpus sizes). Near-viewport blocks (two screens of buffer) and the
selection neighbourhood stay real ProseMirror content. Only default-rendered
types are stubbed in this slice — paragraphs, headings, lists, rules,
blockquotes, frontmatter, source blocks, footnote and link definitions.
Fences, tables, math and HTML blocks keep their existing node views and remain
fully real.

The feature is default-on for those large documents and off below the
threshold, so ordinary notes are unchanged. Host dataset attributes
`data-stub-enabled`, `data-stub-real` and `data-stub-count` expose the window
for packaged benches.

### Body-feel targets (same corpus files as Typora)

Pinned before further tuning, so the next cut answers a feel debt rather than a
micro-benchmark:

| corpus | Typora | Noto body-feel target |
| --- | --- | --- |
| medium (525KB, 2742 blocks) | opens and edits | keystroke and scroll-frame ≤ ~16ms (one frame). Stubbing stays off. |
| large (2MB, 10982 blocks) | never loads | still aim for immediate writing: keystroke toward one frame; scroll without remounting the gap between caret and viewport. |
| huge (8MB) | never loads | usable at all is already ahead of Typora; polish after large feels good. |

### Contiguous real-window bug, fixed 2026-09-11

Stubbing kept a single contiguous `real` span from `min(selection, viewport)` to
`max(...)`. Scrolling away from the caret therefore remounted every block
between them. On the Linux packaged `large` corpus that meant a mid-document
scroll left `real=0-7334` (~3600 real paragraphs) and a median scroll-frame of
about **947ms**. Membership is now OR of the two windows; the gap stays stubbed.

Measured on this Linux box with `node scripts/bench/profile-typing.mjs` against
`out/e2e/Noto-linux-x64` (same probe: scroll `.canvas-scroll` to mid, then type
and step-scroll). Numbers are not the macOS baseline table, but they are
before/after on one machine:

| | mid stubbed | mid real `<p>` | scroll-frame | mid keystroke total |
| --- | --- | --- | --- | --- |
| before (contiguous union) | 3647 | 3667 | 947 ms | 16 ms* |
| after (OR windows) | 10864 | 59 | 60 ms | 17 ms |

\* Keystroke looked fine once thousands of blocks had already remounted; the
feel debt was the scroll that got them there.

macOS packaged re-measure remains useful for the original Apple-silicon table
(`BENCH_RUNS=3 node scripts/bench/run-noto.mjs` /
`node scripts/bench/profile-typing.mjs large`). Unit coverage for windowing,
the enable threshold, and scroll-away gap stubbing lives in
`tests/unit/viewport-stub.test.ts`.

