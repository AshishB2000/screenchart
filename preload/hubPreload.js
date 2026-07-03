'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Brand glyphs for the Execution mode dropdown. This preload is sandboxed and
// can't require('simple-icons'), so main loads the paths (full Node) and we pull
// them synchronously at load time — a tiny { slug: 24×24 path } map. The renderer
// paints each with fill=currentColor; brands not in simple-icons get a badge.
let PROVIDER_LOGOS = {};
try { PROVIDER_LOGOS = ipcRenderer.sendSync('provider:logos') || {}; } catch (_) { PROVIDER_LOGOS = {}; }
// Full-color agent logos (data URIs) for marks not in simple-icons (e.g. Antigravity).
let AGENT_LOGOS = {};
try { AGENT_LOGOS = ipcRenderer.sendSync('agent:logos') || {}; } catch (_) { AGENT_LOGOS = {}; }

// Least-privilege bridge for the hub window.
// The raw API key is NEVER exposed here — only a boolean hasApiKey status.
contextBridge.exposeInMainWorld('hub', {
  // Trigger a screen capture (main gates on hasApiKey).
  takeScreenshot: () => ipcRenderer.send('hub:capture'),
  // Read-only key status: { hasApiKey: boolean, provider: string, keySecure: boolean }.
  getKeyStatus: () => ipcRenderer.invoke('key:status'),
  // Save a remote provider's API key (encrypted in main).
  saveKey: (provider, key) => ipcRenderer.invoke('key:save', { provider, key }),
  // Save a local Ollama endpoint (no API key).
  saveLocalEndpoint: (endpoint) => ipcRenderer.invoke('local:save', { endpoint }),
  // Remove the stored key for a specific provider.
  clearKey: (provider) => ipcRenderer.invoke('key:clear', { provider }),
  // Validate an API key or endpoint; returns { ok, models }.
  validateKey: (provider, key, endpoint) =>
    ipcRenderer.invoke('key:validate', { provider, key, endpoint }),
  // Fetch model list using the stored key (key never leaves main process).
  getModels: (provider) => ipcRenderer.invoke('key:models', { provider }),
  // Save the chosen model for a specific provider.
  saveModel: (provider, model) => ipcRenderer.invoke('model:save', { provider, model }),
  // Switch which provider is used for captures.
  activateProvider: (provider) => ipcRenderer.invoke('provider:activate', { provider }),
  // ── Execution mode / BYOK ──
  // Set execution mode: 'local' | 'byok'.
  setExecutionMode: (mode) => ipcRenderer.invoke('exec:setMode', { mode }),
  // Persist the memory-model choice ({ mode, provider?, model? }).
  setMemoryModel: (fields) => ipcRenderer.invoke('memory:setModel', { fields }),
  // Persist the user's global rules (Instructions / Rules box).
  setGlobalRules: (text) => ipcRenderer.invoke('rules:set', { text }),
  // Completion-notification toggles ({ sound?, desktop? }).
  setNotifications: (fields) => ipcRenderer.invoke('notifications:set', { fields }),
  // Show a benign notification to register the app with the OS when the Desktop
  // toggle is first enabled → { ok, supported }.
  bootstrapNotifications: () => ipcRenderer.invoke('notifications:bootstrap'),
  // Destructive, confirmed-in-MAIN data deletion. scope:
  // 'history' | 'credentials' | 'settings' | 'everything'.
  deleteData: (scope) => ipcRenderer.invoke('data:delete', { scope }),
  // Save a byok provider's editable fields ({ apiKey?, baseUrl?, maxTokens?, model? }).
  saveByokProvider: (provider, fields) => ipcRenderer.invoke('byok:saveProvider', { provider, fields }),
  // Switch the active byok provider.
  activateByokProvider: (provider) => ipcRenderer.invoke('byok:activate', { provider }),
  // Run a minimal real connectivity test; returns a typed result.
  testByokProvider: (provider) => ipcRenderer.invoke('byok:test', { provider }),
  // Reveal a byok provider's saved key (Settings "Show" toggle only, on demand).
  revealByokKey: (provider) => ipcRenderer.invoke('byok:revealKey', { provider }),
  // ── Local CLI detection ──
  // Rescan all known CLIs on PATH; returns { activeId, detectedAt, clis: [...] }.
  detectLocalClis: () => ipcRenderer.invoke('cli:detect'),
  // Re-check a single CLI by id; returns the same shape.
  detectOneCli: (id) => ipcRenderer.invoke('cli:detectOne', { id }),
  // Persist the selected Local CLI (selection only — runs nothing).
  setLocalCli: (id) => ipcRenderer.invoke('cli:setActive', { id }),
  // Run a minimal real prompt through a local CLI; returns a typed result.
  testLocalCli: (id) => ipcRenderer.invoke('cli:test', { id }),
  // List a Local CLI's available models (Antigravity runs `agy models`); { ok, models }.
  listCliModels: (id) => ipcRenderer.invoke('cli:models', { id }),
  // Persist the chosen model for a Local CLI (selection only — runs nothing).
  saveCliModel: (id, model) => ipcRenderer.invoke('cli:saveModel', { id, model }),
  // Shared live model list for a BYOK provider (cache-first; pass force to refresh).
  listModels: (target, force) => ipcRenderer.invoke('models:list', { target, force }),
  // Register a callback fired when main signals the key has changed.
  onKeyChanged: (cb) => ipcRenderer.on('key:changed', () => cb()),
  // Register a callback fired when main wants the settings modal opened at a
  // category (cat string, e.g. 'exec'). Replaces the old setup-panel signal.
  onOpenSettings: (cb) => ipcRenderer.on('hub:open-settings', (_e, cat) => cb(cat)),
  // Open a URL in the default external browser.
  openExternal: (url) => ipcRenderer.send('shell:open', url),
  // Open macOS System Settings to the Screen Recording pane.
  openSystemSettings: () => ipcRenderer.invoke('permission:open-settings'),
  // Register a callback fired when main wants the permission panel shown.
  onShowPermission: (cb) => ipcRenderer.on('hub:show-permission', () => cb()),
  // Lazy-load a large geo boundary set (e.g. 'us_county') on demand from main.
  loadGeo: (level) => ipcRenderer.invoke('geo:load', level),
  // Get the display label for the configured hotkey (platform-aware, from main).
  getHotkeyLabel: () => ipcRenderer.invoke('hotkey:label'),
  // Save a new hotkey accelerator; returns { ok, label?, error? }.
  saveHotkey: (accelerator) => ipcRenderer.invoke('hotkey:save', { accelerator }),
  // Register a callback fired with the hotkey registration state on hub load.
  onHotkeyState: (cb) => ipcRenderer.on('hub:hotkey-state', (_e, data) => cb(data)),
  // Open macOS Privacy & Security → Input Monitoring directly.
  openInputMonitoringSettings: () => ipcRenderer.send('privacy:open-input-monitoring'),
  // Register a callback fired when a new capture entry is ready (any source).
  onNewEntry: (cb) => ipcRenderer.on('hub:new-entry', (_e, data) => cb(data)),
  // Register a callback fired when the AI result arrives for a specific entry.
  onEntryResult: (cb) => ipcRenderer.on('hub:entry-result', (_e, data) => cb(data)),
  // Re-analyze the same crop for an existing entry without re-capturing.
  retry: (entryId) => ipcRenderer.send('hub:retry', { entryId }),
  // Send a follow-up question for an existing entry thread.
  followup: (entryId, text) => ipcRenderer.send('hub:followup', { entryId, text }),
  // Register a callback fired when a follow-up result arrives.
  onFollowupResult: (cb) => ipcRenderer.on('hub:followup-result', (_e, data) => cb(data)),
  // Register a callback fired with persisted history summaries on hub open.
  onHistory: (cb) => ipcRenderer.on('hub:history', (_e, data) => cb(data)),
  // Load a full thread from disk (returns thread data without messages array).
  loadThread: (entryId) => ipcRenderer.invoke('history:load', { entryId }),
  // Delete a thread's files from disk.
  deleteThread: (entryId) => ipcRenderer.invoke('history:delete', { entryId }),
  // Copy text or image to clipboard via main process.
  copyText: (text) => ipcRenderer.send('hub:copyText', text),
  copyImage: (dataUrl) => ipcRenderer.send('hub:copy', dataUrl),
  // Save a screenshot image via the native save panel (user picks the location).
  saveImage: (src, defaultName) => ipcRenderer.invoke('hub:saveImage', { src, defaultName }),
  // Save a generated PDF report (base64 bytes) via the native save panel.
  savePdf: (base64, defaultName) => ipcRenderer.invoke('hub:savePdf', { base64, defaultName }),
  // Save a generated PowerPoint (.pptx) report (base64 bytes) via the native save panel.
  savePptx: (base64, defaultName) => ipcRenderer.invoke('hub:savePptx', { base64, defaultName }),
  // Save a generated Word (.docx) report (base64 bytes) via the native save panel.
  saveDocx: (base64, defaultName) => ipcRenderer.invoke('hub:saveDocx', { base64, defaultName }),
  // Snapshot a page region (DIP rect {x,y,width,height}) to a PNG data URL — used to
  // export the live Leaflet map (tiles + overlay + legend) into reports.
  captureRegion: (rect) => ipcRenderer.invoke('hub:captureRegion', rect),
  // Render a self-contained HTML report to a PNG data URL via a hidden, content-sized
  // window (full-report PNG export). width is the logical page width in px.
  captureReport: (html, width) => ipcRenderer.invoke('hub:captureReport', { html, width }),
  // Theme preference ('system'|'light'|'dark'). Get returns { preference, effective };
  // set persists it and returns the resolved { preference, effective }.
  getThemePreference: () => ipcRenderer.invoke('theme:getPreference'),
  setThemePreference: (preference) => ipcRenderer.invoke('theme:setPreference', preference),
  // Fired when main resolves a new effective theme (OS change in 'system' mode).
  onThemeApply: (cb) => ipcRenderer.on('theme:apply', (_e, data) => cb(data)),
  // Persist chart customization overrides for a specific chart slot in a thread.
  saveChartOverrides: (entryId, key, overrides) =>
    ipcRenderer.invoke('hub:saveChartOverrides', { entryId, key, overrides }),
  // Shared map { providerId: { path, color, title } } for real brand icons (no keys).
  providerLogos: PROVIDER_LOGOS,
  // Static map of { agentId: dataUri } for full-color logos (no keys).
  agentLogos: AGENT_LOGOS,
});
