/**
 * Every control the reader can reach says what it is, to a screen reader
 * too: the main window, Note Info and its tabs, each Settings page, Quick
 * Open, the palette, the guide and the rail's pages. A control with no name
 * is announced as "button" and nothing else. Found the Settings search
 * field when it was added; it guards what comes next.
 */

import { expect, test, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os'; import path from 'node:path';
import { packagedExecutable } from './packaged-app';
const menu = (app: any, id: string) => app.evaluate(({ Menu }: any, itemId: string) => { const f = (items: any[]): any => { for (const i of items) { if (i.id === itemId) return i; const n = i.submenu ? f(i.submenu.items) : null; if (n) return n; } return null; }; f(Menu.getApplicationMenu().items)?.click(); }, id);
const unnamed = (page: any, where: string) => page.evaluate((label: string) => {
  const sel = 'button, [role=button], a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=treeitem], [role=option], [role=switch], [role=checkbox], [role=slider], [tabindex="0"]';
  const out: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    if (el.closest('[hidden], [aria-hidden="true"]')) continue;
    if (el.closest('.ProseMirror')) continue;
    const by = el.getAttribute('aria-labelledby');
    const labelled = by ? by.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim() : '';
    const forLabel = (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '';
    const name = (el.getAttribute('aria-label') ?? '').trim() || labelled || forLabel || (el.textContent ?? '').trim() || (el.getAttribute('title') ?? '').trim();
    if (!name) out.push(`${label}: <${el.tagName.toLowerCase()} class="${el.className}" testid=${el.dataset.testid ?? ''} role=${el.getAttribute('role') ?? ''}>`);
  }
  return out;
}, where);
test('every control the reader can reach has a name', async () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'noto-e2e-names-')));
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, 'notes', 'a.md'), '# A\n\nSee [[b]].\n\n| x | y |\n| - | - |\n| 1 | 2 |\n');
  writeFileSync(path.join(root, 'notes', 'b.md'), '# B\n\nback to a\n');
  mkdirSync(path.join(root, '.noto'));
  execSync('git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm init', { cwd: root });
  const ud = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'noto-e2e-names-ud-')));
  writeFileSync(path.join(ud, 'settings.json'), '{}');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${ud}`, `--folder=${root}`, `--open=${path.join(root, 'notes', 'a.md')}`] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="noto-editor"]');
  await page.waitForTimeout(800);
  const all: string[] = [];
  all.push(...await unnamed(page, 'main'));
  await menu(app, 'toggle-note-info'); await page.waitForTimeout(800);
  all.push(...await unnamed(page, 'note-info'));
  for (const tab of await page.locator('[role="tab"]').all()) { await tab.click().catch(() => {}); await page.waitForTimeout(300); all.push(...await unnamed(page, `info-tab:${await tab.textContent()}`)); }
  await menu(app, 'settings'); await page.waitForTimeout(600);
  for (const section of await page.locator('nav button[data-testid^="pref-"], [data-testid^="pref-"][type="button"]').all()) { await section.click().catch(() => {}); await page.waitForTimeout(250); all.push(...await unnamed(page, `settings:${(await section.textContent())?.trim()}`)); }
  await page.keyboard.press('Escape');
  await menu(app, 'quick-open'); await page.waitForTimeout(400); all.push(...await unnamed(page, 'quick-open')); await page.keyboard.press('Escape');
  await menu(app, 'command-palette'); await page.waitForTimeout(400); all.push(...await unnamed(page, 'palette')); await page.keyboard.press('Escape');
  await menu(app, 'shortcuts'); await page.waitForTimeout(400); all.push(...await unnamed(page, 'guide')); await page.keyboard.press('Escape');
  for (const id of ['toggle-outline', 'search-content']) { await menu(app, id); await page.waitForTimeout(400); all.push(...await unnamed(page, id)); }
  expect([...new Set(all)]).toEqual([]);
  await app.close();
});
