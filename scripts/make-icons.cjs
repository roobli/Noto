/**
 * The app's icon, from `resources/icon/noto.svg`, in every file a platform
 * wants: `noto.icns` for macOS, `noto.ico` for Windows, `noto.png` for Linux.
 *
 * Run with Electron (`pnpm icons`), which draws the SVG as Chromium does,
 * transparency and all; `iconutil` (macOS) packs the icns and ImageMagick's
 * `magick` the ico. The files are committed, so a build needs none of this.
 */

const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const here = path.resolve(__dirname, '..', 'resources', 'icon');
const svg = fs.readFileSync(path.join(here, 'noto.svg'), 'utf8');

async function draw(window, size) {
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}"></body></html>`;
  window.setContentSize(size, size);
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noto-icon-'));
  const set = path.join(work, 'noto.iconset');
  fs.mkdirSync(set);
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  const png = {};
  for (const size of sizes) png[size] = await draw(window, size);
  // The iconset's names: each size, and twice it for a Retina screen.
  for (const size of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${size}x${size}.png`), png[size]);
    fs.writeFileSync(path.join(set, `icon_${size}x${size}@2x.png`), png[size * 2]);
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(here, 'noto.icns')]);
  const icoParts = [16, 32, 64, 128, 256].map((size) => {
    const file = path.join(work, `ico-${size}.png`);
    fs.writeFileSync(file, png[size]);
    return file;
  });
  execFileSync('magick', [...icoParts, path.join(here, 'noto.ico')]);
  fs.writeFileSync(path.join(here, 'noto.png'), png[512]);
  fs.rmSync(work, { recursive: true, force: true });
  console.log('icons written to', here);
  app.quit();
});
