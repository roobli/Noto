# Motion

How the chrome moves, and why the document does not. The budget is an
editor's, not a website's. Someone who lives in a text editor has calibrated
to the near-zero latency of every editor before this one, and feels a 16ms
difference as sluggishness rather than as softness. So the numbers here are
small, the curves front-loaded, and the one surface that matters most, the
document, is left entirely still.

## The tokens

Every duration and curve in the stylesheets is one of these, declared on the
root of `app.scss`. There are no literal milliseconds anywhere else.

| Token | Value | Used for |
| --- | --- | --- |
| `--motion-micro` | 60ms | Hover fills, a press, an icon brightening, a tool bar fading in |
| `--motion-fast` | 80ms | A colour or a small position change |
| `--motion-default` | 100ms | Quick open, the command palette, a menu, Settings arriving; a twisty turning |
| `--motion-medium` | 140ms | The rail's sliding rule, the frontmatter fold, the status notice rising |
| `--motion-slow` | 200ms | The rail itself arriving |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Everything that enters or changes state |
| `--ease-in` | `cubic-bezier(0.7, 0, 0.84, 0)` | Reserved for anything that must animate out |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | Reserved for something repositioning in a layout |

The ease-out curve decelerates hard, so an arriving element seems to be in
place before the press that summoned it has registered. Nothing overshoots.

## The rules

**The document never moves.** No transition on the text, the caret, the
gutter, the scrollbars or the syntax reveal. The one fold on the document
surface, the frontmatter block opening when the caret enters it, is chrome
around metadata rather than prose, and it is the exception that proves the
rule. Highlight and reveal decorations change at 0ms.

**Enter slowly enough to see, leave at once.** Overlays arrive with a breath
of scale and opacity, `noto-arrive`, at the default duration; scrims fade at
micro; the rail slides in from its own edge at slow. Nothing animates out:
when a surface is dismissed it is gone on the same frame, because the
interface should clear faster than it fills, and a fade on Escape reads as a
delay.

**A press is felt.** Icon buttons scale to 0.96 while held and release on
pointer-up, at micro. Text buttons only change fill. Rows in the tree and
the recent strip do not scale at all; scaling a row would move the text the
eye is reading.

**Hover is near-instant.** Fills at micro, never slower. A hover that eases
in over a tenth of a second is a hover that lags the pointer.

**No springs, no bounce.** The rail and the panels use the ease-out curve
rather than a spring, and no curve here has a value past 1. A panel that
wiggles past its resting place would read as broken in a tool this quiet.

**Reduced motion collapses everything.** Under `prefers-reduced-motion`,
the block at the end of `app.scss` sets every transition and animation to
none, and scroll behaviour to instant. Sticky rows, the sliding rule and the
arrivals all resolve to their final state on the first frame.

## Where each pattern lives

- Arrival, `noto-arrive`: Settings, quick open, the command palette, the
  vault-row folder menu.
- Fade, `noto-fade`: the scrims behind Settings and quick open.
- Slide from the edge, `noto-rail-in`: the rail when it opens.
- Rise, `noto-rise`: a plugin's notice in the status line.
- The rail's rule between Files and Outline moves by a custom property at
  medium, so it is arithmetic rather than a measurement and its first frame
  is never in the wrong place.
- The tree's twisty turns at default; the fence's tools fade in at micro.
