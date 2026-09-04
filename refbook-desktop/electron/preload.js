/**
 * preload —— 通过 contextBridge 暴露安全的 IPC 给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cnki', {
  search: (word, size) => ipcRenderer.invoke('cnki:search', word, size),
  detail: (args) => ipcRenderer.invoke('cnki:detail', args),
  ping: () => ipcRenderer.invoke('cnki:ping'),
  onStatus: (cb) => ipcRenderer.on('cnki:status', (_e, ok) => cb(ok)),
  onPopupQuery: (cb) => ipcRenderer.on('popup:query', (_e, word) => cb(word)),
  onPopupMessage: (cb) => ipcRenderer.on('popup:message', (_e, m) => cb(m)),
  closePopup: () => ipcRenderer.send('popup:close'),
  openExternal: (url) => ipcRenderer.send('popup:open-external', url),
  focusMain: () => ipcRenderer.send('popup:focus-main'),
});
