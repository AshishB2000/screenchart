'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('about', {
  openExternal: (url) => ipcRenderer.send('shell:open', url),
});
