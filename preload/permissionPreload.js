'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('permission', {
  openSettings: () => ipcRenderer.invoke('permission:open-settings'),
  done: () => ipcRenderer.send('permission:done'),
});
