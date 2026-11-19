import { describe, expect, it } from 'vitest';
import { fromPageUrl, isPageFile, pageRequestAllowed, toPageUrl, type PageFrameLike } from '../../src/shared/assets/v1/page';
import { resolvePagePath } from '../../src/main/protocol/serve-page';

const root = '/Users/me/笔记';
const id = '0123456789abcdef0123456789abcdef';

describe('a local web page and the files it names', () => {
  it('spells the page under a random name for its folder, so relative files resolve beside it', () => {
    const url = toPageUrl(id, '架构/地图 交互版.html');
    expect(url).toBe(`noto-page://page/${id}/${encodeURIComponent('架构')}/${encodeURIComponent('地图 交互版.html')}`);
    // Nothing of where the folder is on disk.
    expect(url).not.toContain('Users');
    expect(fromPageUrl(new URL('app.js', url))).toEqual({ rootId: id, relative: '架构/app.js' });
    expect(isPageFile('a.HTML')).toBe(true);
    expect(isPageFile('a.md')).toBe(false);
  });

  it('reads no segment that leaves the folder, and no folder by a name not its own', () => {
    expect(fromPageUrl(new URL(`noto-page://page/${id}/a%2F..%2Fb`))).toBeNull();
    expect(fromPageUrl(new URL(`noto-page://page/${id}`))).toBeNull();
    expect(fromPageUrl(new URL(`noto-page://page/${encodeURIComponent(root)}/a.html`))).toBeNull();
    // Climbing past the id leaves the address without one.
    expect(fromPageUrl(new URL(`noto-page://page/${id}/../../etc/passwd`))).toBeNull();
    expect(fromPageUrl(new URL('noto://asset/x'))).toBeNull();
  });

  it('serves only inside a folder the session serves pages from, by real path', async () => {
    const real = async (target: string) => (target.startsWith(`${root}/link`) ? '/etc/passwd' : target);
    const roots = [{ id, root }];
    const ask = (spelled: string, served = roots) => resolvePagePath(new URL(spelled), served, real);
    await expect(ask(toPageUrl(id, 'a.html'))).resolves.toBe(`${root}/a.html`);
    await expect(ask(toPageUrl(id, 'a.html'), [])).resolves.toBeNull();
    await expect(ask(toPageUrl('f'.repeat(32), 'a.html'))).resolves.toBeNull();
    await expect(ask(toPageUrl(id, 'link/x.js'))).resolves.toBeNull();
  });
});

describe('who may ask for a page’s files', () => {
  const window: PageFrameLike = { name: '', url: 'noto://bundle/index.html', parent: null };
  const pageFrame = (url: string): PageFrameLike => ({ name: 'noto-page', url, parent: window });
  const page = pageFrame(`noto-page://page/${id}/map.html`);

  it('answers the page frame, its own documents, and frames inside a page document', () => {
    expect(pageRequestAllowed('subFrame', pageFrame(''))).toBe(true);
    expect(pageRequestAllowed('script', page)).toBe(true);
    expect(pageRequestAllowed('image', page)).toBe(true);
    const nested: PageFrameLike = { name: '', url: '', parent: page };
    expect(pageRequestAllowed('subFrame', nested)).toBe(true);
    expect(pageRequestAllowed('script', { name: '', url: `noto-page://page/${id}/inner.html`, parent: page })).toBe(true);
  });

  it('refuses a web page the page frames, a note’s embed, the window and anything unknown', () => {
    const web: PageFrameLike = { name: '', url: 'https://attacker.example/reader.html', parent: page };
    expect(pageRequestAllowed('xhr', web)).toBe(false);
    expect(pageRequestAllowed('script', web)).toBe(false);
    expect(pageRequestAllowed('subFrame', { name: '', url: '', parent: web })).toBe(false);
    const embed: PageFrameLike = { name: 'noto-embed', url: 'https://embed.example/e.html', parent: window };
    expect(pageRequestAllowed('xhr', embed)).toBe(false);
    expect(pageRequestAllowed('xhr', window)).toBe(false);
    expect(pageRequestAllowed('xhr', null)).toBe(false);
    // Naming a frame like the page frame anywhere else gives it nothing: the name counts only directly under the window.
    const fake: PageFrameLike = { name: 'noto-page', url: 'https://a.example/x.html', parent: embed };
    expect(pageRequestAllowed('xhr', fake)).toBe(false);
    expect(pageRequestAllowed('subFrame', { name: 'noto-page', url: '', parent: embed })).toBe(false);
  });
});
