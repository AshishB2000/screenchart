'use strict';

const {
  app,
  globalShortcut,
  ipcMain,
  systemPreferences,
  nativeTheme,
  Notification,
} = require('electron');

// Single-instance lock. A second launch would otherwise hold its own processes
// and steal/contend the global hotkey, so bail out early and let the first
// instance take over (see the 'second-instance' handler below).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Tell Chromium not to use the OS keychain for its internal encryption key.
// Without this, macOS shows an authorization dialog on every launch for an
// unsigned dev build.
app.commandLine.appendSwitch('password-store', 'basic');

// macOS 14.4+/Sequoia: Electron defaults to the ScreenCaptureKit path for
// desktopCapturer, whose Screen Recording permission handling is broken
// (electron#38190) — getSources can come back denied/black even when the user
// has granted the permission. Force the older, reliable CGDisplayStream/
// CGWindowList capture path by disabling those features. Must be set before the
// app is ready. macOS-only.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'disable-features',
    'ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac'
  );
}

// Windows toast notifications need an explicit AppUserModelID set BEFORE any
// window is created, or they don't show (or show under a generic name). Use the
// app's bundle id for consistency. No-op on macOS/Linux. Signing is NOT required
// on Windows — only this. (macOS notifications still need code-signing — see
// bootstrapNotification below.)
app.setAppUserModelId('app.screenshot.desktop');

// Another launch happened while we're running — focus our existing window.
app.on('second-instance', () => {
  if (hubWindow && !hubWindow.isDestroyed()) {
    if (hubWindow.isMinimized()) hubWindow.restore();
    hubWindow.focus();
  } else {
    openHub();
  }
});

const { captureFrozenFrame, cropToRect, getActiveDisplay } = require('./src/capture');
const config = require('./src/config');
const localCli = require('./src/localCli');
const { analyze, analyzeFollowup } = require('./src/analyze');

console.log('[boot] Screenchart', app.getVersion(), '| packaged =', app.isPackaged);

// The result we persist per turn: the FULL analysis result minus the raw provider
// thread (_messages is stored separately in thread.messages and never goes to the
// renderer). Persisting everything — metrics, headlineProse, extractedTable, geo,
// … — is what lets a reloaded capture render identically to the fresh one (the old
// title/analysis/data/visualizations/followups allowlist dropped the rest).
function persistableResult(result) {
  const { _messages, ...rest } = result;
  return rest;
}
const history = require('./src/history');
const { resolveUserPath } = require('./src/userPath');

// Packaged macOS/Linux GUI launches inherit a stripped PATH (no Homebrew, nvm,
// ~/.local/bin…), which would make Local CLI detection (claude, agy) find nothing.
// Recover the user's real login-shell PATH BEFORE any detection runs. No-op on
// Windows and skipped in dev (`npm start` already has the full terminal PATH).
if (app.isPackaged) {
  const recovered = resolveUserPath();
  console.log('[userPath] recovered PATH —', recovered.split(':').length, 'dirs');
}

const { createStatusWindow } = require('./src/windows/statusWindow');
const { createOverlayWindow } = require('./src/windows/overlayWindow');
const { createHubWindow } = require('./src/windows/hubWindow');

const { platformDefaultHotkey, hotkeyLabel } = require('./src/hotkey');

let statusWindow = null;
let overlayWindow = null;
let hubWindow = null;

// Whether the global shortcut registered successfully on startup.
let hotkeyRegistered = true;

// State for the in-flight capture (single primary display scope).
let frozenFrame = null;
let captureDisplay = null;
let capturing = false;

// Per-entry dataUrl storage so hub can retry without re-capturing.
const entryDataUrls = new Map();
// Per-entry Anthropic messages thread (image + all turns). Never sent to renderer.
const entryThreads = new Map();
// Per-entry persistent data: { id, title, createdAt, updatedAt, cropPath, result, turns }
const entryData = new Map();
// History summaries loaded at startup (sent to hub on open).
let historySummaries = [];

function ensureStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) return statusWindow;
  statusWindow = createStatusWindow();
  statusWindow.on('closed', () => {
    statusWindow = null;
  });
  return statusWindow;
}

function pushStatus(note) {
  const win = ensureStatusWindow();
  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('status:state', { hotkey: hotkeyLabel(config.get().hotkey), note: note || '' });
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function isWayland() {
  return process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
}

function endCapture() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
  frozenFrame = null;
  captureDisplay = null;
  capturing = false;
}

async function startCapture() {
  console.log('[capture] startCapture() called | capturing =', capturing,
    '| packaged =', app.isPackaged);
  if (capturing) return;
  capturing = true;

  if (process.platform === 'darwin') {
    // IMPORTANT: getMediaAccessStatus('screen') is ADVISORY ONLY — we never bail
    // on it. It is documented-unreliable: it caches a STALE 'denied' even after
    // the user grants Screen Recording in System Settings (electron#36722), while
    // desktopCapturer.getSources() actually works. It also never prompts. So we
    // log it for diagnostics, then ATTEMPT the capture regardless and treat the
    // real captured frame as the source of truth — an empty frame (below) is the
    // genuine "no access" signal, and on a fresh ('not-determined') state the
    // getSources() call is what triggers the macOS permission prompt.
    const access = systemPreferences.getMediaAccessStatus('screen');
    console.log('[capture] getMediaAccessStatus(screen) =', access, '(advisory — attempting capture regardless)');
  }

  try {
    // Target the display under the cursor, NOT the primary display — on
    // multi-monitor setups the user may be working on an external monitor whose
    // bounds origin is offset/negative relative to the primary. Capturing and
    // overlaying that display is what makes "New capture" appear where the user
    // is actually looking.
    captureDisplay = getActiveDisplay();
    console.log('[capture] target display', captureDisplay.id,
      '| bounds', JSON.stringify(captureDisplay.bounds),
      '| scaleFactor', captureDisplay.scaleFactor);
    frozenFrame = await captureFrozenFrame(captureDisplay);
    console.log('[capture] frozen frame captured', frozenFrame.getSize());

    // The captured frame is the REAL source of truth (we don't trust the status).
    // An empty frame means Screen Recording genuinely isn't active for this app —
    // open the permission panel (which guides removing a stale entry so macOS can
    // re-grant). A non-empty frame means it works, whatever the status claimed.
    if (frozenFrame.isEmpty()) {
      console.warn('[capture] frozen frame is EMPTY — Screen Recording not active for this app. Opening permission panel.');
      capturing = false;
      openPermission();
      return;
    }

    overlayWindow = createOverlayWindow(captureDisplay);
    // Confirm the window actually landed on the target display's bounds (these
    // should match captureDisplay.bounds above — if they don't, the OS clamped it).
    console.log('[capture] overlay window created — actual bounds',
      JSON.stringify(overlayWindow.getBounds()));
    overlayWindow.on('closed', () => {
      overlayWindow = null;
    });
    overlayWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[capture] overlay did-fail-load', code, desc, url);
      pushStatus('Capture overlay failed to load: ' + desc);
      endCapture();
    });
    overlayWindow.webContents.once('did-finish-load', () => {
      console.log('[capture] overlay did-finish-load — sending frame');
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      // Re-assert bounds + focus: makes sure the overlay sits exactly on the
      // target display and is the active window so the drag-to-select starts
      // immediately (alwaysOnTop alone doesn't always grab focus on macOS).
      overlayWindow.setBounds(captureDisplay.bounds);
      overlayWindow.show();
      overlayWindow.focus();
      overlayWindow.webContents.send('overlay:frame', {
        dataUrl: frozenFrame.toDataURL(),
        width: captureDisplay.size.width,
        height: captureDisplay.size.height,
      });
    });
  } catch (err) {
    // Extract a real reason from ANY thrown value (some rejections carry no
    // .message, which is why this used to print "Capture failed: undefined").
    const reason = (err && (err.message || err.toString())) || String(err) || 'unknown error';
    console.error('[capture] startCapture failed:', err && err.stack || err);
    pushStatus('Capture failed: ' + reason);
    endCapture();
    // The overwhelmingly common cause here is Screen Recording not being active
    // for the app — guide the user to the permission panel instead of a dead end.
    openPermission();
  }
}

// Open the hub and show the Execution mode settings (the modern setup surface —
// Local CLI + BYOK live here). Replaces the old standalone/onboarding setup.
function openExecutionSettings() {
  if (!hubWindow || hubWindow.isDestroyed()) {
    hubWindow = createHubWindow();
    hubWindow.on('closed', () => { hubWindow = null; });
    hubWindow.webContents.once('did-finish-load', () => {
      if (hubWindow && !hubWindow.isDestroyed()) {
        hubWindow.webContents.send('hub:open-settings', 'exec');
      }
    });
  } else {
    hubWindow.focus();
    hubWindow.webContents.send('hub:open-settings', 'exec');
  }
}

// Push the current hotkey registration state to the hub (both success and
// failure) so the banner shows on failure and clears on success.
function notifyHotkeyState() {
  if (!hubWindow || hubWindow.isDestroyed()) return;
  console.log('[hotkey] notifyHotkeyState read hotkeyRegistered =', hotkeyRegistered);
  hubWindow.webContents.send('hub:hotkey-state', {
    registered: hotkeyRegistered,
    label: hotkeyLabel(config.get().hotkey),
  });
}

// Open (or focus) the hub window.
function openHub() {
  if (hubWindow && !hubWindow.isDestroyed()) {
    hubWindow.focus();
    notifyHotkeyState();
    return;
  }
  hubWindow = createHubWindow();
  hubWindow.on('closed', () => { hubWindow = null; });
  hubWindow.webContents.once('did-finish-load', () => {
    if (!hubWindow || hubWindow.isDestroyed()) return;
    hubWindow.webContents.send('hub:history', historySummaries);
    notifyHotkeyState();
  });
}

// Notify the hub that key status changed (if it's open).
function notifyKeyChanged() {
  if (hubWindow && !hubWindow.isDestroyed()) {
    hubWindow.webContents.send('key:changed');
  }
}

// Best-effort OS notification when an analysis turn finishes AND the window is
// not focused. Gated on the user's setting; failures are swallowed so they can
// never block or error the analysis. (The completion SOUND is played in the
// renderer — see hub.js.)
function maybeNotifyDone(title) {
  try {
    const prefs = config.get().notifications || {};
    if (!prefs.desktop) return;
    if (hubWindow && !hubWindow.isDestroyed() && hubWindow.isFocused()) return;
    if (!Notification.isSupported || !Notification.isSupported()) return;
    new Notification({
      title: 'Screenchart',
      body: title ? `Analysis ready — ${title}` : 'Analysis ready.',
      silent: false,
    }).show();
  } catch (_) { /* never block analysis */ }
}

// Register with the OS the moment the user ENABLES the Desktop toggle — a benign,
// focus-independent show — so the app appears in System Settings → Notifications,
// instead of lazily on the first unfocused completion (which the OS may silently
// drop). Electron exposes no allow/deny status here, so `supported:false` only
// means the platform has no notifications at all; the renderer nudges toward
// System Settings either way.
//
// KNOWN macOS LIMITATION (signing-dependent, not a code bug): Apple's
// UNUserNotification API requires the app to be code-signed to emit; an UNSIGNED
// build emits a 'failed' event and shows nothing. So this bootstrap is correct
// but macOS notifications stay non-functional until the app is signed. Windows
// has no such requirement — the AppUserModelID set above is enough.
function bootstrapNotification() {
  try {
    if (!Notification.isSupported || !Notification.isSupported()) return { ok: false, supported: false };
    new Notification({
      title: 'Screenchart',
      body: 'Desktop notifications are on. You’ll be alerted when an analysis finishes and this window isn’t focused.',
      silent: true,
    }).show();
    return { ok: true, supported: true };
  } catch (_) {
    return { ok: false, supported: false };
  }
}
ipcMain.handle('notifications:bootstrap', () => bootstrapNotification());

// Show the permission panel inside the hub (single-window experience).
function openPermission() {
  if (!hubWindow || hubWindow.isDestroyed()) {
    hubWindow = createHubWindow();
    hubWindow.on('closed', () => { hubWindow = null; });
    hubWindow.webContents.once('did-finish-load', () => {
      if (hubWindow && !hubWindow.isDestroyed()) {
        hubWindow.webContents.send('hub:show-permission');
      }
    });
  } else {
    hubWindow.focus();
    hubWindow.webContents.send('hub:show-permission');
  }
}

// Detect Local CLIs ONCE at startup using the recovered PATH, so the capture
// readiness gate (config.executionReady) is correct from the very FIRST hotkey
// press — without the user having to open Settings first. This is the missing
// link that made New capture "do nothing" from a Finder launch: detection only
// ran on settings-open, so the gate read a stale/empty cache and silently routed
// capture to settings. Bounded by readVersion's hard guard (never hangs); runs in
// the background so it never delays the hub.
async function refreshLocalCliDetectionAtStartup() {
  try {
    const results = await localCli.detectAll();
    config.saveLocalCliDetection(results);
    const installed = results.filter((r) => r && r.status === 'installed').map((r) => r.id);
    console.log('[localCli] startup detection complete — installed:', installed.join(', ') || 'none');
    notifyKeyChanged(); // refresh the hub's readiness badge if it's already open
  } catch (err) {
    console.error('[localCli] startup detection failed:', err && err.message);
  }
}

// ── IPC: capture overlay ──────────────────────────────────────────────────

ipcMain.on('capture:commit', (_e, rect) => {
  if (!frozenFrame || !captureDisplay) {
    endCapture();
    return;
  }
  const cropped = cropToRect(frozenFrame, rect, captureDisplay);
  endCapture();
  if (!cropped) return;

  const dataUrl = cropped.toDataURL();
  const entryId = Date.now();
  const createdAt = new Date().toISOString();
  entryDataUrls.set(entryId, dataUrl);

  // Save crop image to disk immediately so it's available even if analysis fails.
  history.saveCrop(entryId, dataUrl).then(cropPath => {
    const stub = entryData.get(entryId) || {};
    stub.cropPath = cropPath;
    entryData.set(entryId, stub);
  }).catch(err => console.error('[history] saveCrop failed:', err.message));

  function sendToHub() {
    if (!hubWindow || hubWindow.isDestroyed()) return;
    hubWindow.focus();
    hubWindow.webContents.send('hub:new-entry', { entryId, dataUrl });
    analyze(dataUrl).then(result => {
      if (!hubWindow || hubWindow.isDestroyed()) return;
      if (result.ok && result._messages) {
        entryThreads.set(entryId, result._messages);
        const data = entryData.get(entryId) || {};
        const thread = {
          id: entryId,
          title: result.title || 'Analysis',
          createdAt,
          updatedAt: new Date().toISOString(),
          cropPath: data.cropPath || null,
          messages: result._messages,
          result: persistableResult(result),
          turns: [],
        };
        entryData.set(entryId, thread);
        history.saveThread(thread).catch(e => console.error('[history] saveThread failed:', e.message));
        // Update sidebar summaries cache so re-opened hub sees this entry
        historySummaries = [{ id: entryId, title: thread.title, updatedAt: thread.updatedAt, cropPath: thread.cropPath }, ...historySummaries.filter(s => s.id !== entryId)];
        delete result._messages;
      }
      hubWindow.webContents.send('hub:entry-result', { entryId, ...result });
      if (result.ok) maybeNotifyDone(result.title);
    }).catch(() => {
      if (!hubWindow || hubWindow.isDestroyed()) return;
      hubWindow.webContents.send('hub:entry-result', {
        entryId, ok: false, errorType: 'unknown', message: 'Something went wrong. Try again.',
      });
    });
  }

  if (!hubWindow || hubWindow.isDestroyed()) {
    hubWindow = createHubWindow();
    hubWindow.on('closed', () => { hubWindow = null; });
    hubWindow.webContents.once('did-finish-load', sendToHub);
  } else {
    sendToHub();
  }
});

ipcMain.on('capture:cancel', () => {
  endCapture();
});

// ── IPC: hub ──────────────────────────────────────────────────────────────

ipcMain.on('hub:open', openHub);

// Take-screenshot / new-capture: gate on execution readiness (Local CLI OR BYOK),
// not just an API key. When not ready, open the Execution mode settings.
ipcMain.on('hub:capture', () => {
  const ready = config.executionReady();
  console.log('[capture] hub:capture (New capture button) | executionReady =', ready);
  if (!ready) {
    openExecutionSettings();
    return;
  }
  startCapture();
});

// ── IPC: key management ───────────────────────────────────────────────────

// Returns { isReady, hasApiKey, provider, theme, ... } — no raw key.
ipcMain.handle('key:status', () => config.publicConfig());

require("./src/ipc/geo").register();

require("./src/ipc/theme").register({ getHubWindow: () => hubWindow });

require("./src/ipc/providers").register({ getHubWindow: () => hubWindow, notifyKeyChanged });

require("./src/ipc/cli").register({ notifyKeyChanged });

// ── IPC: hotkey ───────────────────────────────────────────────────────────

// Return the display label for the configured hotkey — renderers must not compute it.
ipcMain.handle('hotkey:label', () => ({
  label: hotkeyLabel(config.get().hotkey),
  accelerator: config.get().hotkey,
}));

// Save a new hotkey: unregister old, register new, persist if successful.
ipcMain.handle('hotkey:save', (_e, { accelerator }) => {
  if (typeof accelerator !== 'string' || !accelerator.trim()) {
    return { ok: false, error: 'Empty accelerator' };
  }
  const newHotkey = accelerator.trim();
  const oldHotkey = config.get().hotkey;

  globalShortcut.unregister(oldHotkey);

  const handler = () => {
    if (!config.executionReady()) { openExecutionSettings(); return; }
    startCapture();
  };

  const registered = globalShortcut.register(newHotkey, handler);
  if (registered) {
    config.save({ hotkey: newHotkey });
    hotkeyRegistered = true;
    return { ok: true, label: hotkeyLabel(newHotkey), accelerator: newHotkey };
  }

  // New hotkey failed — restore the old one.
  hotkeyRegistered = globalShortcut.register(oldHotkey, handler);
  return { ok: false, error: 'Could not register — it may be in use by another app' };
});

require("./src/ipc/shell").register();

// ── IPC: hub capture actions ──────────────────────────────────────────────

// Re-analyze the same crop for a specific entry without re-capturing.
ipcMain.on('hub:retry', (_e, { entryId }) => {
  const dataUrl = entryDataUrls.get(entryId);
  if (!dataUrl || !hubWindow || hubWindow.isDestroyed()) return;
  entryThreads.delete(entryId);
  const existingData = entryData.get(entryId);
  analyze(dataUrl).then(result => {
    if (!hubWindow || hubWindow.isDestroyed()) return;
    if (result.ok && result._messages) {
      entryThreads.set(entryId, result._messages);
      const thread = {
        id: entryId,
        title: result.title || 'Analysis',
        createdAt: existingData ? existingData.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cropPath: existingData ? existingData.cropPath : null,
        messages: result._messages,
        result: persistableResult(result),
        turns: [],
      };
      entryData.set(entryId, thread);
      history.saveThread(thread).catch(e => console.error('[history] saveThread (retry) failed:', e.message));
      historySummaries = [{ id: entryId, title: thread.title, updatedAt: thread.updatedAt, cropPath: thread.cropPath }, ...historySummaries.filter(s => s.id !== entryId)];
      delete result._messages;
    }
    hubWindow.webContents.send('hub:entry-result', { entryId, ...result });
    if (result.ok) maybeNotifyDone(result.title); // parity with initial capture + follow-up
  }).catch(() => {
    if (!hubWindow || hubWindow.isDestroyed()) return;
    hubWindow.webContents.send('hub:entry-result', {
      entryId, ok: false, errorType: 'unknown', message: 'Something went wrong. Try again.',
    });
  });
});

// Follow-up question on an existing thread.
ipcMain.on('hub:followup', (_e, { entryId, text }) => {
  const messages = entryThreads.get(entryId);
  if (!messages || !hubWindow || hubWindow.isDestroyed()) return;
  analyzeFollowup(messages, text).then(result => {
    if (!hubWindow || hubWindow.isDestroyed()) return;
    if (result.ok && result._messages) {
      entryThreads.set(entryId, result._messages);
      const thread = entryData.get(entryId);
      if (thread) {
        thread.updatedAt = new Date().toISOString();
        thread.messages = result._messages;
        thread.turns = thread.turns || [];
        thread.turns.push({
          text,
          state: 'result',
          result: persistableResult(result),
        });
        history.saveThread(thread).catch(e => console.error('[history] saveThread (followup) failed:', e.message));
        historySummaries = [{ id: entryId, title: thread.title, updatedAt: thread.updatedAt, cropPath: thread.cropPath }, ...historySummaries.filter(s => s.id !== entryId)];
      }
      delete result._messages;
    }
    hubWindow.webContents.send('hub:followup-result', { entryId, ...result });
    if (result.ok) maybeNotifyDone(result.title);
  }).catch(() => {
    if (!hubWindow || hubWindow.isDestroyed()) return;
    hubWindow.webContents.send('hub:followup-result', {
      entryId, ok: false, errorType: 'unknown', message: 'Something went wrong. Try again.',
    });
  });
});

require("./src/ipc/historyIpc").register({ entryData, entryThreads, entryDataUrls });

require("./src/ipc/clipboard").register();

require("./src/ipc/fileSave").register();

require("./src/ipc/capture").register();

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  config.load();

  // Recompute Local CLI availability with the recovered PATH before the user can
  // trigger capture (the readiness gate reads this). Background — bounded by the
  // readVersion guard, so it never blocks the hub or hangs.
  refreshLocalCliDetectionAtStartup();

  // Apply the saved theme preference to nativeTheme so 'system' tracks the OS
  // and forced light/dark are honored before any window opens.
  nativeTheme.themeSource = config.get().themePreference || 'system';

  // On first run (or migration from the old cross-platform default), store the
  // platform-specific default so the configured accelerator is always explicit.
  const storedHotkey = config.get().hotkey;
  const platformDefault = platformDefaultHotkey();
  if (!storedHotkey || storedHotkey === 'CommandOrControl+Shift+S') {
    if (storedHotkey !== platformDefault) config.save({ hotkey: platformDefault });
  }

  // Gate the global hotkey on execution readiness (Local CLI OR BYOK).
  const registerReturn = globalShortcut.register(config.get().hotkey, () => {
    const ready = config.executionReady();
    console.log('[capture] hotkey fired | executionReady =', ready);
    if (!ready) {
      openExecutionSettings();
      return;
    }
    startCapture();
  });

  // register() returns false if the accelerator is already registered, but the
  // shortcut is still active in that case — so isRegistered() is the truth.
  hotkeyRegistered = registerReturn || globalShortcut.isRegistered(config.get().hotkey);

  console.log('[hotkey] register() returned:', registerReturn,
    '| isRegistered:', globalShortcut.isRegistered(config.get().hotkey),
    '| hotkeyRegistered:', hotkeyRegistered);

  if (!hotkeyRegistered) {
    console.warn('[hotkey] Failed to register', config.get().hotkey,
      '— it may be claimed by another app');
  }

  // Init history store and load summaries before opening the hub.
  try {
    await history.init();
    historySummaries = await history.loadAllSummaries();
  } catch (err) {
    console.error('[history] Failed to load summaries on startup:', err.message);
    historySummaries = [];
  }

  // Always open the hub on launch.
  openHub();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// On macOS, re-open the hub when the dock icon is clicked.
app.on('activate', () => {
  openHub();
});
