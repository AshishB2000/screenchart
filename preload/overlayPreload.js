'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Overlay bridge: receive the frozen frame, send back either a committed
// selection rect (CSS px) or a cancel.
contextBridge.exposeInMainWorld('overlay', {
  onFrame: (cb) => ipcRenderer.on('overlay:frame', (_e, data) => cb(data)),
  commit: (rect) => ipcRenderer.send('capture:commit', rect),
  cancel: () => ipcRenderer.send('capture:cancel'),
});
