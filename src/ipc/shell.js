'use strict';

const { ipcMain, shell } = require('electron');
const { providerLogos, agentLogos } = require('../icons');

// Shell / logos IPC — synchronous brand-glyph payloads for the sandboxed hub
// preload, external-URL opening, and the macOS System-Settings deep links.
// Extracted from main.js as a pure structural move. No state, no window refs.
function register() {
  // Synchronous: the sandboxed hub preload can't require simple-icons, so it
  // pulls the brand glyph paths from main at load time (tiny one-shot payload).
  ipcMain.on('provider:logos', (e) => { e.returnValue = providerLogos; });
  ipcMain.on('agent:logos', (e) => { e.returnValue = agentLogos; });

  ipcMain.on('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
  });

  ipcMain.on('privacy:open-input-monitoring', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  });

  // Open macOS Privacy → Screen Recording settings.
  ipcMain.handle('permission:open-settings', () => {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  });
}

module.exports = { register };
