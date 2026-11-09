/**
 * Inline math with Pandoc's dollar rule.
 *
 * `micromark-extension-math` opens single-dollar math at any `$` and closes
 * it at the next one, so a line of prices, `$8,000 - $50,000`, read as math
 * holding `8,000 - ` and the rest as text. 694 lines in 124 of the author's
 * notes have that shape (daily-use audit, finding 12). Pandoc's
 * `tex_math_dollars` rule is the one people who write prices and formulas in
 * the same notes already rely on: a single `$` opens math only with a
 * non-space character right after it, and closes it only with a non-space
 * character right before it and no digit right after. So `$20,000 and
 * $30,000` stays text, and `$x$`, `$\alpha + 1$` stay math.
 *
 * Runs of two or more dollars keep micromark's rule unchanged: `$$ x $$` with
 * its padding, and a closing run that must match the opening one.
 *
 * The tokenizer and resolver are those of `micromark-extension-math` 3.1.0
 * (MIT, Titus Wormer), with the three checks above added; token types are the
 * same, so `mdast-util-math` reads the result as before. The engine's own
 * scanner (`endOfSimpleInlineMath` in `pm/from-engine.ts`) applies the same
 * rule, and typing applies it too (`inlineMathRule`), so a note reads the
 * same whichever path parsed a block.
 */

import type {
  Code, Construct, Effects, Event, Previous, Resolver, State, Token, TokenizeContext,
} from 'micromark-util-types';

/*
 * micromark's character codes, as `micromark-util-symbol` names them: line
 * endings and tabs are negative virtual codes, and `null` is the end.
 */
const codes = { eof: null, dollarSign: 36, space: 32, digit0: 48, digit9: 57 } as const;
const types = { lineEnding: 'lineEnding', characterEscape: 'characterEscape' } as const;
/** CR, LF and CRLF (`micromark-util-character`'s `markdownLineEnding`). */
const markdownLineEnding = (code: Code): boolean => code !== null && code < -2;
/** Tab, virtual space and space (`markdownSpace`). */
const markdownSpace = (code: Code): boolean => code === -2 || code === -1 || code === codes.space;

/** A code Pandoc's rule treats as white space next to a dollar. */
const blank = (code: Code): boolean => code === codes.eof || markdownLineEnding(code) || markdownSpace(code);
const digit = (code: Code): boolean => code !== null && code >= codes.digit0 && code <= codes.digit9;

function tokenizeMathText(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let sizeOpen = 0;
  let size = 0;
  let token: Token | undefined;
  /** The last code consumed inside the span, so a close can see what is before it. */
  let last: Code = codes.dollarSign;
  /** Whether the dollar run now being read came right after white space. */
  let closeAfterBlank = false;

  const start: State = (code) => {
    effects.enter('mathText');
    effects.enter('mathTextSequence');
    return sequenceOpen(code);
  };

  const sequenceOpen: State = (code) => {
    if (code === codes.dollarSign) {
      effects.consume(code);
      sizeOpen += 1;
      return sequenceOpen;
    }
    // Pandoc: one dollar opens math only with something other than a space after it.
    if (sizeOpen === 1 && blank(code)) return nok(code);
    effects.exit('mathTextSequence');
    return between(code);
  };

  const between: State = (code) => {
    if (code === codes.eof) return nok(code);
    if (code === codes.dollarSign) {
      token = effects.enter('mathTextSequence');
      size = 0;
      closeAfterBlank = blank(last);
      return sequenceClose(code);
    }
    if (code === codes.space) {
      effects.enter('space');
      effects.consume(code);
      effects.exit('space');
      last = code;
      return between;
    }
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      last = code;
      return between;
    }
    effects.enter('mathTextData');
    return data(code);
  };

  const data: State = (code) => {
    if (code === codes.eof || code === codes.space || code === codes.dollarSign || markdownLineEnding(code)) {
      effects.exit('mathTextData');
      return between(code);
    }
    effects.consume(code);
    last = code;
    return data;
  };

  const sequenceClose: State = (code) => {
    if (code === codes.dollarSign) {
      effects.consume(code);
      size += 1;
      last = code;
      return sequenceClose;
    }
    // Pandoc: one dollar closes only after something other than a space, and
    // not before a digit, so `$5` in `$a, $5` is a price inside the span.
    const closes = size === sizeOpen && !(sizeOpen === 1 && (closeAfterBlank || digit(code)));
    if (closes) {
      effects.exit('mathTextSequence');
      effects.exit('mathText');
      return ok(code);
    }
    if (token) token.type = 'mathTextData';
    return data(code);
  };

  return start;
}

/** Unchanged from `micromark-extension-math`: strip one padding space on each side, merge data. */
const resolveMathText: Resolver = (events: Event[]) => {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index: number;
  let enter: number | undefined;

  if (
    (events[headEnterIndex]![1].type === types.lineEnding || events[headEnterIndex]![1].type === 'space')
    && (events[tailExitIndex]![1].type === types.lineEnding || events[tailExitIndex]![1].type === 'space')
  ) {
    index = headEnterIndex;
    while (++index < tailExitIndex) {
      if (events[index]![1].type === 'mathTextData') {
        events[tailExitIndex]![1].type = 'mathTextPadding';
        events[headEnterIndex]![1].type = 'mathTextPadding';
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }

  index = headEnterIndex - 1;
  tailExitIndex += 1;
  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && events[index]![1].type !== types.lineEnding) enter = index;
    } else if (index === tailExitIndex || events[index]![1].type === types.lineEnding) {
      events[enter]![1].type = 'mathTextData';
      if (index !== enter + 2) {
        events[enter]![1].end = events[index - 1]![1].end;
        events.splice(enter + 2, index - enter - 2);
        tailExitIndex -= index - enter - 2;
        index = enter + 2;
      }
      enter = undefined;
    }
  }
  return events;
};

/** Unchanged: a dollar cannot open right after another one unless that one was escaped. */
const previous: Previous = function previous(this: TokenizeContext, code: Code): boolean {
  return code !== codes.dollarSign || this.events[this.events.length - 1]![1].type === types.characterEscape;
};

export const mathTextPandoc: Construct = {
  name: 'mathText',
  tokenize: tokenizeMathText,
  resolve: resolveMathText,
  previous,
};
