/**
 * Electron 主进程
 *
 * 职责：
 *  - 主窗口：手动输入查词（常驻）
 *  - 弹窗窗口：全局快捷键 Ctrl+Shift+D 触发，读取系统选区/剪贴板，
 *    在屏幕中央偏上位置弹出无框小窗展示查询结果
 *  - IPC：渲染进程通过 cnki:search / cnki:detail 调用查询逻辑
 */

const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen, shell } = require('electron');
const path = require('path');
const { searchRefbook, fetchEntryDetail, ping } = require('./cnki');

let mainWin = null;
let popupWin = null;
let lastPopupQuery = '';

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 880,
    height: 640,
    title: '工具书查词 · 桌面版',
    icon: path.join(__dirname, '..', 'public', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'main.html'));
  mainWin.on('closed', () => { mainWin = null; });
}

function createPopupWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = 460, h = 380;
  popupWin = new BrowserWindow({
    width: w, height: h,
    x: Math.round((sw - w) / 2),
    y: Math.round(sh * 0.25),
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popupWin.loadFile(path.join(__dirname, '..', 'renderer', 'popup.html'));
  popupWin.on('blur', () => { if (popupWin) popupWin.hide(); });
  popupWin.on('closed', () => { popupWin = null; });
}

/** 读取选中文本：优先 PRIMARY 选区（Linux 选中即复制），回退 clipboard */
function getSelectionText() {
  // Electron clipboard 在 Linux 上不直接读 PRIMARY 选区，用 availableFormats 判断
  const text = clipboard.readText('selection');
  if (text && text.trim()) return text.trim();
  const clip = clipboard.readText();
  return clip && clip.trim() ? clip.trim() : '';
}

function triggerSelectionLookup() {
  const text = getSelectionText();
  if (!text) {
    maybeShowPopup('（未检测到选中文本）', true);
    return;
  }
  if (!popupWin) createPopupWindow();
  const wc = popupWin.webContents;
  const send = () => wc.send('popup:query', text);
  if (wc.isLoading()) wc.once('did-finish-load', send);
  else send();
  lastPopupQuery = text;
  popupWin.show();
  popupWin.focus();
}
function maybeShowPopup(msg, isError) {
  if (!popupWin) createPopupWindow();
  const wc = popupWin.webContents;
  const send = () => wc.send('popup:message', { msg, isError });
  if (wc.isLoading()) wc.once('did-finish-load', send);
  else send();
  popupWin.show();
}

// ---------- IPC ----------
ipcMain.handle('cnki:search', (_e, word, size) => searchRefbook(word, size || 8));
ipcMain.handle('cnki:detail', (_e, args) => fetchEntryDetail(args));
ipcMain.handle('cnki:ping', () => ping());
ipcMain.on('popup:close', () => { if (popupWin) popupWin.hide(); });
ipcMain.on('popup:open-external', (_e, url) => { if (url) shell.openExternal(url); });
ipcMain.on('popup:focus-main', () => {
  if (!mainWin) createMainWindow();
  mainWin.show();
  mainWin.focus();
});

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  createMainWindow();
  createPopupWindow();

  const ret = globalShortcut.register('CommandOrControl+Shift+D', triggerSelectionLookup);
  if (!ret) console.error('全局快捷键注册失败');

  ping().then((ok) => {
    console.log(ok ? '[自检] CNKI 接口连通正常' : '[自检] CNKI 接口暂不可达');
    if (mainWin) mainWin.webContents.send('cnki:status', ok);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
