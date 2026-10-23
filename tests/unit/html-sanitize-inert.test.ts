/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeHtml, sanitizeToHtml, worthDrawing } from '../../src/renderer/editor/noto/html-sanitize';

// An <img> that is given a src while it belongs to the page's own document
// starts loading at once, attached or not; that is how `new Image()` preloads.
// So a note's picture must not hold its written address on a live element
// before the resolver has had its say, or a web image is fetched with web
// images turned off. Every src a live-document <img> is given is recorded.

const WEB = '<div><img src="https://example.invalid/x.png" alt="web"></div>';

let given: string[] = [];
let restore: () => void = () => {};

beforeEach(() => {
  given = [];
  const proto = HTMLImageElement.prototype;
  const setAttribute = Element.prototype.setAttribute;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (this instanceof HTMLImageElement && name.toLowerCase() === 'src' && this.ownerDocument === document) given.push(value);
    return setAttribute.call(this, name, value);
  };
  if (descriptor?.set) {
    Object.defineProperty(proto, 'src', {
      ...descriptor,
      set(this: HTMLImageElement, value: string) {
        if (this.ownerDocument === document) given.push(value);
        descriptor.set!.call(this, value);
      },
    });
  }
  restore = () => {
    Element.prototype.setAttribute = setAttribute;
    if (descriptor) Object.defineProperty(proto, 'src', descriptor);
  };
});

afterEach(() => restore());

describe('cleaning a note\u2019s HTML asks the network for nothing', () => {
  it('deciding whether a block is worth drawing gives no live picture an address', () => {
    expect(worthDrawing(WEB)).toBe(true);
    expect(given).toEqual([]);
  });

  it('the cleaned copy keeps the written address for the resolver without handing it to a live picture', () => {
    const drawn = sanitizeHtml(WEB);
    expect(given).toEqual([]);
    // Which document owns the fragment is the real browser's business and is
    // checked in the packaged test; happy-dom's fragments do not keep it.
    expect(drawn.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/x.png');
  });

  it('still cleans the same way', () => {
    expect(sanitizeToHtml('<p onclick="x()" class="a">Hi<script>1</script></p><img src="./a.png" onerror="x()">'))
      .toBe('<p>Hi</p><img src="./a.png">');
    expect(given).toEqual([]);
  });
});
