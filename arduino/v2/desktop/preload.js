'use strict';
// コンソールのページ（app://console/index.html と v1.html）にだけ window.cosmicDesktop を出す。
// ほかのページ（解析・マニュアル・書き込み）は CDN のスクリプトも読むので、何も出さない。
const { contextBridge, ipcRenderer } = require('electron');

const here = new URL(location.href);
// index.html（V2・v2.1・OKOME）と v1.html（v1・OWAN）の 2 つ。
const isConsole = here.protocol === 'app:' && here.host === 'console' &&
                  ['/', '/index.html', '/v1.html'].includes(here.pathname);

if (isConsole) {
  contextBridge.exposeInMainWorld('cosmicDesktop', {
    // 保存先は { path, name }。書き込みのたびに path を渡し、アプリ側で渡したフォルダかを確かめる。
    saveDir: () => ipcRenderer.invoke('desk:saveDir'),
    chooseSaveDir: () => ipcRenderer.invoke('desk:chooseSaveDir'),
    fileSize: (dir, name) => ipcRenderer.invoke('desk:fileSize', String(dir), String(name)),
    appendFile: (dir, name, text, pos) => ipcRenderer.invoke('desk:appendFile', String(dir), String(name),
                                                            String(text), Number.isFinite(pos) ? pos : null),
    status: (s) => ipcRenderer.send('desk:status', s),
    userAction: (a) => ipcRenderer.send('desk:userAction', String(a)),
    ready: (pageName) => ipcRenderer.send('desk:ready', String(pageName || '')),
  });
}
