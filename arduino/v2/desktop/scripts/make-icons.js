'use strict';
// アイコンを作る: npm run icons
// コンソールの紋章（assets/img/crest-ohashi.svg）を、隠したウィンドウで描いて PNG にする。
//   build/icon.png  512×512（インストーラとウィンドウ）
//   build/tray.png  32×32（トレイ。表示するときに 16 / 18 に縮める）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, '..', '..', 'console', 'assets', 'img', 'crest-ohashi.svg'), 'utf8');
const outDir = path.join(__dirname, '..', 'build');

// 小さな窓は作れないので、512 で描いてから縮める。
async function render(size) {
  const w = new BrowserWindow({
    width: size, height: size, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block">
    </body></html>`;
  await w.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise(r => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  w.destroy();
  return img.resize({ width: size, height: size });
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const big = await render(512);
  fs.writeFileSync(path.join(outDir, 'icon.png'), big.toPNG());
  fs.writeFileSync(path.join(outDir, 'tray.png'), big.resize({ width: 32, height: 32, quality: 'best' }).toPNG());
  console.log('wrote build/icon.png (512) and build/tray.png (32)');
  app.quit();
});
