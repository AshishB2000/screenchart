'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

// Small always-present window that tells the user the hotkey (and surfaces
// permission / platform warnings).
function createStatusWindow() {
  const win = new BrowserWindow({
    width: 400,
    height: 320,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Screenchart',
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'statusPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(ROOT, 'renderer', 'status', 'index.html'));
  return win;
}

module.exports = { createStatusWindow };
