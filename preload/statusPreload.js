'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Least-privilege bridge: status window only listens for its display text.
// NB: the namespace is 'screenchart', not 'status' — window.status is a reserved
// legacy DOM property that only holds strings, so a bridge object can't live there.
contextBridge.exposeInMainWorld('screenchart', {
  onState: (cb) => ipcRenderer.on('status:state', (_e, data) => cb(data)),
  openHub: () => ipcRenderer.send('hub:open'),
});
