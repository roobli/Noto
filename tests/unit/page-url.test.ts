import { describe, expect, it } from 'vitest';
import { fromPageUrl, isPageFile, toPageUrl } from '../../src/shared/assets/v1/page';
import { resolvePagePath } from '../../src/main/protocol/serve-page';

const root = '/Users/me/笔记';

describe('a local web page and the files it names', () => {
  it('spells the page under its folder, so relative files resolve beside it', () => {
    const url = toPageUrl(root, `${root}/架构/地图 交互版.html`);
    expect(url).toBe(`noto://page/${encodeURIComponent(root)}/${encodeURIComponent('架构')}/${encodeURIComponent('地图 交互版.html')}`);
    const script = new URL('app.js', url);
    expect(fromPageUrl(script)).toEqual({ root, relative: '架构/app.js' });
    expect(isPageFile('a.HTML')).toBe(true);
    expect(isPageFile('a.htm')).toBe(true);
    expect(isPageFile('a.md')).toBe(false);
  });

  it('reads no segment that leaves the folder', () => {
    // The URL parser folds `..`, encoded or not, within the path before anything sees it.
    expect(fromPageUrl(new URL(`noto://page/${encodeURIComponent(root)}/a/%2E%2E/b`))).toEqual({ root, relative: 'b' });
    // Climbing past the folder's segment names another folder, which is not one the session opened.
    expect(fromPageUrl(new URL(`noto://page/${encodeURIComponent(root)}/../../etc/passwd`))?.root).toBe('etc');
    expect(fromPageUrl(new URL(`noto://page/${encodeURIComponent(root)}/a%2F..%2Fb`))).toBeNull();
    expect(fromPageUrl(new URL(`noto://page/${encodeURIComponent(root)}`))).toBeNull();
    expect(fromPageUrl(new URL('noto://asset/x'))).toBeNull();
  });

  it('serves only inside a folder the session has open, by real path', async () => {
    const real = async (target: string) => (target.startsWith('/Users/me/笔记/link') ? '/etc/passwd' : target);
    const ask = (spelled: string, roots: string[]) => resolvePagePath(new URL(spelled), roots, real);
    const page = toPageUrl(root, `${root}/a.html`);
    await expect(ask(page, [root])).resolves.toBe(`${root}/a.html`);
    await expect(ask(page, ['/Users/other'])).resolves.toBeNull();
    await expect(ask(toPageUrl(root, `${root}/link/x.js`), [root])).resolves.toBeNull();
    await expect(ask(`noto://page/${encodeURIComponent('/Users')}/me/笔记/a.html`, [root])).resolves.toBeNull();
    await expect(ask(`noto://page/${encodeURIComponent(root)}/../../etc/passwd`, [root])).resolves.toBeNull();
  });
});
