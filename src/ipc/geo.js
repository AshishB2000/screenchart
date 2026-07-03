'use strict';

const { ipcMain, app } = require('electron');

// Lazy-load a large geo boundary file on demand (the hub CSP blocks fetch, and
// these files are too big to eager-load at startup). Whitelisted level → file,
// parsed result cached per level. Returns an empty FeatureCollection on miss.
const GEO_FILES = { us_county: 'us-counties.json' };
const geoCache = new Map();

function register() {
  ipcMain.handle('geo:load', async (_e, level) => {
    if (geoCache.has(level)) return geoCache.get(level);
    const file = GEO_FILES[level];
    const empty = { type: 'FeatureCollection', features: [] };
    if (!file) return empty;
    try {
      const fsp = require('fs').promises;
      const p = require('path').join(app.getAppPath(), 'assets', 'geo', file);
      const data = JSON.parse(await fsp.readFile(p, 'utf8'));
      geoCache.set(level, data);
      return data;
    } catch (err) {
      console.error('[geo] Failed to load', level, err.message);
      return empty;
    }
  });
}

module.exports = { register };
