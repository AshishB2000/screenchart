'use strict';

const { ipcMain } = require('electron');
const config = require('../config');
const localCli = require('../localCli');
const { testLocalCli } = require('../analyze');
const liveModels = require('../models');
const { listAntigravityModels, listGrokModels, listOpenCodeModels, listCursorModels } = require('../localCliRun');

// Local CLI detection + model IPC — cli:detect/detectOne/setActive/test/models/
// saveModel and the shared models:list. Extracted from main.js as a pure
// structural move; notifyKeyChanged arrives via deps. No logic changes.
function register({ notifyKeyChanged }) {
  // ── IPC: Local CLI detection ──────────────────────────────────────────────
  // Detection ONLY runs registry binaries with their fixed versionArgs — never a
  // command built from user/AI/config input. Returns the renderer-safe view.

  // Full rescan: probe every registry entry, persist, return public view.
  // Hard overall timeout so the renderer's "Scanning your PATH…" spinner can
  // never spin forever — even if some probe stalls beyond readVersion's guard,
  // we fall back to the last persisted results and return.
  ipcMain.handle('cli:detect', async () => {
    let timer;
    try {
      const timeout = new Promise((_r, reject) => {
        timer = setTimeout(() => reject(new Error('detectAll timed out (15s)')), 15000);
        if (timer.unref) timer.unref();
      });
      const results = await Promise.race([localCli.detectAll(), timeout]);
      config.saveLocalCliDetection(results);
    } catch (err) {
      console.error('[cli:detect] error', err && err.message);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return config.publicLocalCli();
  });

  // Re-check a single CLI by id; merge into stored results.
  ipcMain.handle('cli:detectOne', async (_e, { id }) => {
    try {
      const one = await localCli.detectOne(id);
      if (one) {
        const det = config.get().localCli.lastDetection;
        const results = (det && Array.isArray(det.results)) ? det.results.slice() : [];
        const idx = results.findIndex(r => r && r.id === id);
        if (idx >= 0) results[idx] = one; else results.push(one);
        config.saveLocalCliDetection(results);
      }
    } catch (err) {
      console.error('[cli:detectOne] error', err && err.message);
    }
    return config.publicLocalCli();
  });

  // Persist the selected Local CLI (selection only — does not run anything).
  ipcMain.handle('cli:setActive', (_e, { id }) => {
    const result = config.setLocalCliActive(id);
    if (result.ok) notifyKeyChanged();
    return result;
  });

  // Run a minimal real prompt through a local CLI adapter; typed result.
  ipcMain.handle('cli:test', async (_e, { id }) => {
    try {
      return await testLocalCli(id);
    } catch (err) {
      console.error('[cli:test] error', err && err.message);
      return { ok: false, errorType: 'unknown', message: 'Test failed. Try again.' };
    }
  });

  // List a Local CLI's available models. LIVE lists run the CLI's own command:
  // Antigravity (`agy models`), Grok (`grok models`), OpenCode (`opencode models`),
  // Cursor (`cursor-agent --list-models`, needs auth → empty until connected).
  // Claude Code and Codex are CURATED STATIC lists (neither has a list command).
  // Returns { ok, models: [...] }; renderer falls back to "Default" when !ok.
  const LIVE_LISTERS = {
    antigravity: listAntigravityModels,
    grok: listGrokModels,
    opencode: listOpenCodeModels,
    cursor: listCursorModels,
  };
  ipcMain.handle('cli:models', async (_e, { id } = {}) => {
    if (id === 'claude') return { ok: true, models: localCli.CLAUDE_MODELS };
    if (id === 'codex') return { ok: true, models: localCli.CODEX_MODELS };
    const lister = LIVE_LISTERS[id];
    if (!lister) return { ok: false, models: [] };
    try {
      return await lister();
    } catch (err) {
      console.error('[cli:models] error', err && err.message);
      return { ok: false, models: [] };
    }
  });

  // Persist the chosen model for a Local CLI (selection only — runs nothing).
  ipcMain.handle('cli:saveModel', (_e, { id, model } = {}) => {
    return config.setLocalCliModel(id, model);
  });

  // Shared live model list for a BYOK provider — used by BOTH the header dropdown
  // and the Execution mode settings pane so they never disagree. Renders the
  // cached list instantly, then refreshes; on any failure falls back to the last
  // cached list so the dropdown never empties. Keys stay in main (see src/models).
  const MODEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1h: serve cache, refresh in background
  ipcMain.handle('models:list', async (_e, { target, force } = {}) => {
    if (typeof target !== 'string') return { models: [], source: 'none' };
    const cached = config.getModelCache(target);
    const fresh = cached && (Date.now() - new Date(cached.at).getTime() < MODEL_CACHE_TTL_MS);
    if (cached && fresh && !force) {
      return { models: cached.models, at: cached.at, source: 'cache' };
    }
    let result;
    try { result = await liveModels.listModels(target); }
    catch (err) { console.error('[models:list]', err && err.message); result = { ok: false, errorType: 'unknown', models: [] }; }

    if (result.ok && result.models.length) {
      config.setModelCache(target, result.models);
      return { models: result.models, at: new Date().toISOString(), source: 'live' };
    }
    // Distinct reasons so the UI can explain WHY it fell back:
    //   no_key | auth | network | provider | unknown (from src/models) — or 'empty'
    //   when the provider replied OK but nothing matched our filters.
    const reason = result.ok ? 'empty' : (result.errorType || 'unknown');
    console.warn(`[models:list] ${target} → ${reason} (showing ${cached ? 'cached list' : 'nothing'})`);
    if (cached) return { models: cached.models, at: cached.at, source: 'cache', error: reason };
    return { models: [], source: 'none', error: reason };
  });
}

module.exports = { register };
