'use strict';

const { ipcMain, nativeTheme } = require('electron');
const config = require('../config');
const { setHubTitleBarOverlay } = require('../windows/hubWindow');

// ── Theme preference (single source of truth) ───────────────────────────────
// themePreference is 'system' | 'light' | 'dark'. 'system' follows the OS via
// nativeTheme. The effective theme ('light'|'dark') is resolved here and pushed
// to the renderer, which only ever applies a concrete light/dark value.
// Extracted from main.js as a pure structural move; hubWindow arrives via the
// getHubWindow getter (it is a reassigned ref owned by main.js).
function effectiveTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function register({ getHubWindow }) {
  ipcMain.handle('theme:getPreference', () => ({
    preference: config.get().themePreference || 'system',
    effective: effectiveTheme(),
  }));

  ipcMain.handle('theme:setPreference', (_e, preference) => {
    const cfg = config.save({ themePreference: preference });
    // nativeTheme.themeSource accepts exactly 'system'|'light'|'dark'.
    nativeTheme.themeSource = cfg.themePreference;
    const effective = effectiveTheme();
    setHubTitleBarOverlay(getHubWindow(), effective); // repaint Windows controls to match
    return { preference: cfg.themePreference, effective };
  });

  // Re-apply live when the OS theme changes (only meaningful in 'system' mode).
  nativeTheme.on('updated', () => {
    const hubWindow = getHubWindow();
    if (hubWindow && !hubWindow.isDestroyed()) {
      const effective = effectiveTheme();
      hubWindow.webContents.send('theme:apply', { effective });
      setHubTitleBarOverlay(hubWindow, effective); // repaint Windows controls to match
    }
  });
}

module.exports = { register };
