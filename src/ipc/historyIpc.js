'use strict';

const { ipcMain } = require('electron');
const history = require('../history');

// History / persistence IPC — load & delete persisted threads, and persist
// per-chart customization overrides. Extracted from main.js as a pure structural
// move; the in-memory entry Maps arrive via deps (same instances, mutated in
// place). No logic changes.
function register({ entryData, entryThreads, entryDataUrls }) {
  // Load a full thread from disk; also restores entryThreads and entryDataUrls so
  // follow-ups and retry work after the thread is opened from history.
  ipcMain.handle('history:load', async (_e, { entryId }) => {
    const thread = await history.loadThread(entryId);
    if (!thread) return null;
    // Restore messages for follow-up continuity — never forwarded to renderer.
    if (Array.isArray(thread.messages)) {
      entryThreads.set(thread.id, thread.messages);
    }
    // Restore dataUrl for retry — read crop file back to base64.
    if (thread.cropPath) {
      try {
        const { promises: fsp } = require('fs');
        const buf = await fsp.readFile(thread.cropPath);
        entryDataUrls.set(thread.id, 'data:image/png;base64,' + buf.toString('base64'));
      } catch (_) {}
    }
    entryData.set(thread.id, thread);
    // Strip messages before sending to renderer — raw API history stays in main.
    const { messages: _msgs, ...safeThread } = thread;
    return safeThread;
  });

  // Delete a thread's files and remove it from in-memory caches.
  ipcMain.handle('history:delete', async (_e, { entryId }) => {
    const ok = await history.deleteThread(entryId);
    if (ok) {
      entryDataUrls.delete(entryId);
      entryThreads.delete(entryId);
      entryData.delete(entryId);
      historySummaries = historySummaries.filter(s => s.id !== entryId);
    }
    return { ok };
  });

  // ── IPC: chart customization overrides ───────────────────────────────────────
  // Merges a per-chart override into the thread's persisted chartOverrides map.
  ipcMain.handle('hub:saveChartOverrides', async (_e, { entryId, key, overrides }) => {
    if (!entryId || !key) return { ok: false };
    let thread = entryData.get(entryId);
    if (!thread) {
      thread = await history.loadThread(entryId);
      if (!thread) return { ok: false };
    }
    if (!thread.chartOverrides) thread.chartOverrides = {};
    if (overrides === null) {
      delete thread.chartOverrides[key];
    } else {
      thread.chartOverrides[key] = overrides;
    }
    thread.updatedAt = new Date().toISOString();
    entryData.set(entryId, thread);
    history.saveThread(thread).catch(e => console.error('[history] saveChartOverrides failed:', e.message));
    return { ok: true };
  });
}

module.exports = { register };
