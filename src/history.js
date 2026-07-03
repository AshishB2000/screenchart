'use strict';

// History persistence — MAIN PROCESS ONLY.
// Each thread is stored as userData/history/<threadId>/thread.json + crop.png.
// The Anthropic messages array (including base64 image) is stored in thread.json;
// it is the user's own data on their own machine, never transmitted anywhere.
// API keys are NEVER written here.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let historyDir = null;

function getHistoryDir() {
  if (!historyDir) historyDir = path.join(app.getPath('userData'), 'history');
  return historyDir;
}

function threadDir(id) {
  return path.join(getHistoryDir(), String(id));
}

function threadFilePath(id) {
  return path.join(threadDir(id), 'thread.json');
}

function cropFilePath(id) {
  return path.join(threadDir(id), 'crop.png');
}

// Create history directory on first run.
async function init() {
  await fs.promises.mkdir(getHistoryDir(), { recursive: true });
}

// Write the crop image (from a data URL) to disk. Returns the absolute path.
async function saveCrop(id, dataUrl) {
  const dir = threadDir(id);
  await fs.promises.mkdir(dir, { recursive: true });
  const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const p = cropFilePath(id);
  await fs.promises.writeFile(p, buf);
  return p;
}

// Save (create or overwrite) a thread file.
// thread: { id, title, createdAt, updatedAt, cropPath, messages, result, turns }
async function saveThread(thread) {
  const dir = threadDir(thread.id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(threadFilePath(thread.id), JSON.stringify(thread, null, 2), 'utf8');
}

// Return all thread summaries for the sidebar, newest-first.
// Skips corrupt/missing files gracefully.
async function loadAllSummaries() {
  const dir = getHistoryDir();
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const summaries = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const id = dirent.name;
    try {
      const raw = await fs.promises.readFile(threadFilePath(id), 'utf8');
      const data = JSON.parse(raw);
      if (!data.id) continue;
      summaries.push({
        id: data.id,
        title: data.title || 'Analysis',
        updatedAt: data.updatedAt || data.createdAt,
        cropPath: data.cropPath || null,
      });
    } catch (err) {
      // ENOENT = orphaned capture (crop.png saved, thread.json never written, e.g.
      // analysis didn't finish). Not corruption — skip quietly. Only log real damage.
      if (err.code !== 'ENOENT') {
        console.error('[history] Skipping corrupt or unreadable thread:', id, err.message);
      }
    }
  }

  summaries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return summaries;
}

// Load a single thread's full data. Returns null if missing or corrupt.
async function loadThread(id) {
  try {
    const raw = await fs.promises.readFile(threadFilePath(id), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// Delete a thread's directory (thread.json + crop.png).
async function deleteThread(id) {
  try {
    await fs.promises.rm(threadDir(id), { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

// Delete the ENTIRE history directory (all threads, thread.json + crop.png).
// Only ever called from an explicit, confirmed user action. Returns the dir path
// so the caller can report exactly what was removed.
async function clearAll() {
  const dir = getHistoryDir();
  await fs.promises.rm(dir, { recursive: true, force: true });
  historyDir = null; // force re-resolve (and re-create on next init)
  return dir;
}

module.exports = { init, saveCrop, saveThread, loadAllSummaries, loadThread, deleteThread, clearAll };
