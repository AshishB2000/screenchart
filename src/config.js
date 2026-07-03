'use strict';

// Config + API-key storage. MAIN PROCESS ONLY.
//
// Schema v2: per-provider {apiKey/endpoint, model} stored under cfg.providers.
// Raw keys never leave main process; renderers see only {hasKey, model} per provider.
// config.json is in .gitignore so keys never enter version control.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const localCli = require('./localCli');

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter', 'ollama', 'custom'];

// ── Execution mode (BYOK) ───────────────────────────────────────────────────
// New richer per-provider shape for the Execution mode rework. Lives alongside
// the legacy `providers` block (kept for the old setup panel) — analyze routes
// via this byok block. apiKey stays plaintext on disk (established decision).
const EXECUTION_MODES = ['local', 'byok'];
const BYOK_PROVIDERS = ['anthropic', 'openai', 'gemini', 'gateway'];

// Per-provider defaults. baseUrl is the API root (adapters append their path);
// maxTokens '' means "use the adapter's tuned default". All user-editable.
const BYOK_DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com',                       model: 'claude-sonnet-4-6'  },
  openai:    { baseUrl: 'https://api.openai.com/v1',                       model: 'gpt-4o'             },
  gemini:    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash'   },
  gateway:   { baseUrl: '',                                                 model: ''                  },
};

function freshByokProvider(prov) {
  const d = BYOK_DEFAULTS[prov] || { baseUrl: '', model: '' };
  // verified: true only after a successful connectivity test (see setByokVerified).
  // A saved key alone is NOT "connected" — it must validate first.
  return { apiKey: null, baseUrl: d.baseUrl, maxTokens: '', model: d.model, verified: false };
}

function freshByok() {
  const providers = {};
  for (const p of BYOK_PROVIDERS) providers[p] = freshByokProvider(p);
  return { activeProvider: 'anthropic', providers };
}

const THEMES = ['light', 'dark'];
// Single source of truth for the UI theme. 'system' follows the OS (resolved in
// main via nativeTheme); 'light'/'dark' force that theme.
const THEME_PREFERENCES = ['system', 'light', 'dark'];

function freshProviders() {
  return {
    anthropic:  { apiKey: null, model: '' },
    openai:     { apiKey: null, model: '' },
    gemini:     { apiKey: null, model: '' },
    openrouter: { apiKey: null, model: '' },
    ollama:     { endpoint: '', model: '' },
    custom:     { apiKey: null, model: '' },
  };
}

const DEFAULTS = {
  version: 2,
  activeProvider: 'anthropic',
  executionMode: 'local',
  // Local CLI detection state. lastDetection: { at: ISO, results: [{id,status,version,resolvedPath}] }
  // models: per-CLI selected model, e.g. { antigravity: 'Gemini 3.5 Flash (Medium)' }.
  localCli: { activeId: null, lastDetection: null, models: {} },
  // Which model handles memory/summary work, distinct from the main analyze call.
  // mode 'same_as_chat' uses the active execution path; 'override' falls back to a
  // specific BYOK provider family. NOTE: no memory step is wired yet — see analyze.js.
  memoryModel: { mode: 'same_as_chat', provider: null, model: '' },
  // Last good live model list per provider/CLI, so dropdowns render instantly
  // then refresh. Keyed by provider name or CLI id: { key: { at: ISO, models: [{id,label}] } }.
  modelCache: {},
  hotkey: 'CommandOrControl+Alt+S',
  theme: 'light',
  themePreference: 'system',
  prompt: '',
  // User's free-text "Instructions / Rules", appended ADDITIVELY to the system
  // prompt for every analysis (see analyze.js buildSystemPrompt). Empty = none.
  globalRules: '',
  // Completion notifications, both OFF by default. sound: play a short beep when
  // an analysis turn finishes. desktop: OS notification when it finishes AND the
  // window isn't focused. Best-effort — never block/error the analysis.
  notifications: { sound: false, desktop: false },
};

const MEMORY_MODES = ['same_as_chat', 'override'];

let cache = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function sanitize(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if (PROVIDERS.includes(input.activeProvider)) out.activeProvider = input.activeProvider;
  if (EXECUTION_MODES.includes(input.executionMode)) out.executionMode = input.executionMode;
  if (typeof input.hotkey === 'string' && input.hotkey.trim()) out.hotkey = input.hotkey.trim();
  if (THEMES.includes(input.theme)) out.theme = input.theme;
  if (THEME_PREFERENCES.includes(input.themePreference)) out.themePreference = input.themePreference;
  if (typeof input.prompt === 'string') out.prompt = input.prompt;
  if (typeof input.globalRules === 'string') out.globalRules = input.globalRules;
  if (input.notifications && typeof input.notifications === 'object') {
    out.notifications = {
      sound: Boolean(input.notifications.sound),
      desktop: Boolean(input.notifications.desktop),
    };
  }
  return out;
}

function migrate(cfg) {
  // v1 → v2: flat {provider, apiKey, endpoint, model} → {activeProvider, providers}
  if (!cfg.version || cfg.version < 2) {
    const oldProv     = cfg.provider  || 'anthropic';
    const oldKey      = cfg.apiKey    || null;
    const oldEndpoint = cfg.endpoint  || '';
    const oldModel    = cfg.model     || '';
    const provs = freshProviders();
    if (oldProv === 'ollama') {
      provs.ollama = { endpoint: oldEndpoint, model: oldModel };
    } else if (oldKey) {
      provs[oldProv] = { apiKey: oldKey, model: oldModel };
    }
    cfg.providers      = provs;
    cfg.activeProvider = oldProv;
    delete cfg.provider; delete cfg.apiKey; delete cfg.endpoint; delete cfg.model;
    cfg.version = 2;
  }
  // Ensure all provider slots exist (handles partial disk state)
  cfg.providers = { ...freshProviders(), ...cfg.providers };

  // Seed the byok block from the legacy providers on first run after the
  // Execution mode rework. Copies (does not delete) so the old block still works.
  if (!cfg.byok || typeof cfg.byok !== 'object') {
    const byok = freshByok();
    const legacy = cfg.providers || {};
    // Direct 1:1 maps; gateway (OpenAI-compatible) inherits from custom, else openrouter.
    const copyKeyModel = (from, to) => {
      const src = legacy[from] || {};
      if (src.apiKey) byok.providers[to].apiKey = src.apiKey;
      if (src.model)  byok.providers[to].model = src.model;
    };
    copyKeyModel('anthropic', 'anthropic');
    copyKeyModel('openai', 'openai');
    copyKeyModel('gemini', 'gemini');
    if (legacy.custom && legacy.custom.apiKey) copyKeyModel('custom', 'gateway');
    else if (legacy.openrouter && legacy.openrouter.apiKey) copyKeyModel('openrouter', 'gateway');

    // Map the legacy active provider into a byok provider.
    const a = cfg.activeProvider;
    byok.activeProvider = BYOK_PROVIDERS.includes(a) ? a
      : (a === 'custom' || a === 'openrouter') ? 'gateway'
      : 'anthropic';
    cfg.byok = byok;
  }
  // Backfill any missing byok provider slots / fields (partial disk state).
  if (!EXECUTION_MODES.includes(cfg.executionMode)) cfg.executionMode = 'local';
  cfg.byok.providers = cfg.byok.providers || {};
  for (const p of BYOK_PROVIDERS) {
    cfg.byok.providers[p] = { ...freshByokProvider(p), ...cfg.byok.providers[p] };
  }
  if (!BYOK_PROVIDERS.includes(cfg.byok.activeProvider)) cfg.byok.activeProvider = 'anthropic';

  // Ensure the localCli block exists (detection state persisted across launches).
  if (!cfg.localCli || typeof cfg.localCli !== 'object') {
    cfg.localCli = { activeId: null, lastDetection: null, models: {} };
  }
  if (!('activeId' in cfg.localCli)) cfg.localCli.activeId = null;
  if (!('lastDetection' in cfg.localCli)) cfg.localCli.lastDetection = null;
  // Per-CLI selected model (e.g. { antigravity: 'Gemini 3.5 Flash (Medium)' }).
  if (!cfg.localCli.models || typeof cfg.localCli.models !== 'object') cfg.localCli.models = {};

  // Ensure the model-list cache exists.
  if (!cfg.modelCache || typeof cfg.modelCache !== 'object') cfg.modelCache = {};

  // Validate / backfill the memoryModel block.
  if (!cfg.memoryModel || typeof cfg.memoryModel !== 'object') {
    cfg.memoryModel = { mode: 'same_as_chat', provider: null, model: '' };
  }
  if (!MEMORY_MODES.includes(cfg.memoryModel.mode)) cfg.memoryModel.mode = 'same_as_chat';
  if (!BYOK_PROVIDERS.includes(cfg.memoryModel.provider)) cfg.memoryModel.provider = null;
  if (typeof cfg.memoryModel.model !== 'string') cfg.memoryModel.model = '';
  // Adopt themePreference from a pre-existing light/dark theme, else default to system.
  if (!THEME_PREFERENCES.includes(cfg.themePreference)) {
    cfg.themePreference = THEMES.includes(cfg.theme) ? cfg.theme : 'system';
  }
  return cfg;
}

function persist(cfg) {
  cache = cfg;
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

function load() {
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) {}
  const merged = { ...DEFAULTS, ...sanitize(onDisk) };
  merged.providers = { ...freshProviders(), ...(onDisk.providers || {}) };
  // Carry the byok block through verbatim; migrate() backfills/validates it.
  if (onDisk.byok && typeof onDisk.byok === 'object') merged.byok = onDisk.byok;
  if (onDisk.localCli && typeof onDisk.localCli === 'object') merged.localCli = onDisk.localCli;
  if (onDisk.modelCache && typeof onDisk.modelCache === 'object') merged.modelCache = onDisk.modelCache;
  if (onDisk.memoryModel && typeof onDisk.memoryModel === 'object') merged.memoryModel = onDisk.memoryModel;
  cache = migrate(merged);
  return cache;
}

function get() {
  return cache || load();
}

function save(partial) {
  const cfg = get();
  Object.assign(cfg, sanitize(partial));
  persist(cfg);
  return cfg;
}

// ── Per-provider key / model helpers ────────────────────────────────────────

function provData(prov) {
  return get().providers[prov] || {};
}

function hasKey(prov) {
  const d = provData(prov);
  return prov === 'ollama' ? Boolean(d.endpoint) : Boolean(d.apiKey);
}

// Store an API key for a cloud provider. Sets that provider as active.
async function setApiKey(plaintext, provider) {
  if (typeof plaintext !== 'string' || !plaintext) return { ok: false };
  const prov = (typeof provider === 'string' && PROVIDERS.includes(provider))
    ? provider : get().activeProvider;
  if (prov === 'ollama') return { ok: false };
  const cfg = get();
  cfg.providers[prov] = { ...cfg.providers[prov], apiKey: plaintext };
  cfg.activeProvider = prov;
  persist(cfg);
  return { ok: true };
}

// Return the raw key for a provider — main-process only.
async function getApiKey(provider) {
  const prov = provider || get().activeProvider;
  return provData(prov).apiKey || null;
}

// Store an Ollama endpoint. Sets ollama as active.
function setOllamaEndpoint(endpoint) {
  const cfg = get();
  cfg.providers.ollama = { ...cfg.providers.ollama, endpoint };
  cfg.activeProvider = 'ollama';
  persist(cfg);
  return { ok: true };
}

// Clear a specific provider's credential. If it was active, switch to another.
function clearProviderKey(provider) {
  const cfg = get();
  const prov = (typeof provider === 'string' && PROVIDERS.includes(provider))
    ? provider : cfg.activeProvider;

  if (cfg.providers[prov]) {
    if (prov === 'ollama') {
      cfg.providers[prov].endpoint = '';
    } else {
      cfg.providers[prov].apiKey = null;
    }
  }

  if (prov === cfg.activeProvider) {
    // Find another provider that still has a key
    const other = PROVIDERS.find(p => {
      if (p === prov) return false;
      const d = cfg.providers[p] || {};
      return p === 'ollama' ? Boolean(d.endpoint) : Boolean(d.apiKey);
    });
    cfg.activeProvider = other || 'anthropic';
  }

  persist(cfg);
  return { ok: true };
}

// Save the chosen model for a specific provider.
function setModel(model, provider) {
  const cfg = get();
  const prov = (typeof provider === 'string' && PROVIDERS.includes(provider))
    ? provider : cfg.activeProvider;
  cfg.providers[prov] = { ...cfg.providers[prov], model: typeof model === 'string' ? model.trim() : '' };
  persist(cfg);
  return { ok: true };
}

// Change which provider is used for captures.
function setActiveProvider(provider) {
  if (!PROVIDERS.includes(provider)) return { ok: false };
  const cfg = get();
  cfg.activeProvider = provider;
  persist(cfg);
  return { ok: true };
}

// ── Execution mode / BYOK helpers ───────────────────────────────────────────

function setExecutionMode(mode) {
  if (!EXECUTION_MODES.includes(mode)) return { ok: false };
  const cfg = get();
  cfg.executionMode = mode;
  persist(cfg);
  return { ok: true };
}

// Persist the memory-model choice. fields: { mode, provider?, model? }.
// Setting-only today — no memory step consumes it yet (see analyze.js stub).
function setMemoryModel(fields) {
  const cfg = get();
  const cur = cfg.memoryModel || { mode: 'same_as_chat', provider: null, model: '' };
  const next = { ...cur };
  if (fields && MEMORY_MODES.includes(fields.mode)) next.mode = fields.mode;
  if (fields && 'provider' in fields) {
    next.provider = BYOK_PROVIDERS.includes(fields.provider) ? fields.provider : null;
  }
  if (fields && typeof fields.model === 'string') next.model = fields.model;
  if (next.mode === 'same_as_chat') { next.provider = null; next.model = ''; }
  cfg.memoryModel = next;
  persist(cfg);
  return { ok: true, memoryModel: next };
}

// Full byok entry for a provider INCLUDING the raw key — main-process only.
function getByokProvider(prov) {
  const p = BYOK_PROVIDERS.includes(prov) ? prov : get().byok.activeProvider;
  return { provider: p, ...freshByokProvider(p), ...(get().byok.providers[p] || {}) };
}

// Merge editable fields (apiKey/baseUrl/maxTokens/model) into a provider entry.
function setByokProvider(prov, fields) {
  if (!BYOK_PROVIDERS.includes(prov)) return { ok: false };
  const cfg = get();
  const cur = cfg.byok.providers[prov] || freshByokProvider(prov);
  const next = { ...cur };
  // A changed credential (key or endpoint) invalidates any prior verification —
  // it must be re-tested before the provider is "connected" again.
  if (typeof fields.apiKey === 'string')   { next.apiKey = fields.apiKey || null; next.verified = false; }
  if (typeof fields.baseUrl === 'string')  { next.baseUrl = fields.baseUrl.trim(); next.verified = false; }
  if (typeof fields.model === 'string')    next.model = fields.model.trim();
  if (fields.maxTokens !== undefined)      next.maxTokens = String(fields.maxTokens || '').trim();
  cfg.byok.providers[prov] = next;
  persist(cfg);
  return { ok: true };
}

// A provider is "connected" only when its credential is present AND a real
// connectivity test has verified it. A key string alone is not connected.
function byokConnected(prov) {
  if (!BYOK_PROVIDERS.includes(prov)) return false;
  const d = get().byok.providers[prov] || {};
  if (!d.verified) return false;
  return prov === 'gateway' ? Boolean(d.baseUrl) : Boolean(d.apiKey);
}

// The provider that should actually be Active: the stored one if it's connected,
// else the first connected provider, else null (nothing connected → no Active).
function effectiveByokActive() {
  const stored = get().byok.activeProvider;
  if (byokConnected(stored)) return stored;
  return BYOK_PROVIDERS.find(byokConnected) || null;
}

// Flip a provider's verified flag — true only after a successful connectivity
// test. Persisted so the popup/settings reflect Connected across reopens.
function setByokVerified(prov, ok) {
  if (!BYOK_PROVIDERS.includes(prov)) return { ok: false };
  const cfg = get();
  const cur = cfg.byok.providers[prov] || freshByokProvider(prov);
  cfg.byok.providers[prov] = { ...cur, verified: Boolean(ok) };
  persist(cfg);
  return { ok: true };
}

// Active requires Connected: refuse to activate a provider that hasn't verified.
function setByokActiveProvider(prov) {
  if (!BYOK_PROVIDERS.includes(prov)) return { ok: false };
  if (!byokConnected(prov)) return { ok: false, error: 'not_connected' };
  const cfg = get();
  cfg.byok.activeProvider = prov;
  persist(cfg);
  return { ok: true };
}

// ── Local CLI detection state ───────────────────────────────────────────────

// Persist a detection scan (full results, incl. internal resolvedPath) + timestamp.
function saveLocalCliDetection(results) {
  const cfg = get();
  cfg.localCli.lastDetection = {
    at: new Date().toISOString(),
    results: Array.isArray(results) ? results : [],
  };
  persist(cfg);
  return { ok: true };
}

// Set the selected Local CLI (must be a known registry id, or null to clear).
function setLocalCliActive(id) {
  const valid = id === null || localCli.REGISTRY.some(e => e.id === id);
  if (!valid) return { ok: false };
  const cfg = get();
  cfg.localCli.activeId = id;
  persist(cfg);
  return { ok: true };
}

// Internal-only: the full stored detection result for one id (incl. resolvedPath).
function getLocalCliResult(id) {
  const det = get().localCli.lastDetection;
  const results = (det && det.results) || [];
  return results.find(r => r && r.id === id) || null;
}

// Persist the chosen model for a Local CLI (must be a known registry id).
// Empty/non-string clears it (CLI default).
function setLocalCliModel(id, model) {
  if (!localCli.REGISTRY.some(e => e.id === id)) return { ok: false };
  const cfg = get();
  const m = typeof model === 'string' ? model.trim() : '';
  if (m) cfg.localCli.models[id] = m;
  else delete cfg.localCli.models[id];
  persist(cfg);
  return { ok: true };
}

// The selected model for a Local CLI, or '' when none (use the CLI default).
function getLocalCliModel(id) {
  const models = get().localCli.models || {};
  return models[id] || '';
}

// Model-list cache (last good live list per provider/CLI key).
function setModelCache(key, models) {
  if (typeof key !== 'string' || !Array.isArray(models)) return { ok: false };
  const cfg = get();
  cfg.modelCache[key] = { at: new Date().toISOString(), models };
  persist(cfg);
  return { ok: true };
}
function getModelCache(key) {
  const c = get().modelCache || {};
  return c[key] || null;
}

// Renderer-safe view: activeId + merged registry/detection list, NO resolvedPath.
function publicLocalCli() {
  const cfg = get();
  const det = cfg.localCli.lastDetection;
  return {
    activeId: cfg.localCli.activeId || null,
    detectedAt: (det && det.at) || null,
    models: { ...(cfg.localCli.models || {}) },
    clis: localCli.toPublic(det && det.results),
  };
}

// Renderer-safe byok view: per-provider hasKey + baseUrl/maxTokens/model, NO keys.
function publicByok() {
  const cfg = get();
  const providers = {};
  for (const p of BYOK_PROVIDERS) {
    const d = cfg.byok.providers[p] || freshByokProvider(p);
    providers[p] = {
      hasKey:    Boolean(d.apiKey),
      verified:  Boolean(d.verified),
      connected: byokConnected(p),  // hasKey/baseUrl AND verified
      baseUrl:   d.baseUrl || '',
      maxTokens: d.maxTokens || '',
      model:     d.model || '',
    };
  }
  // activeProvider is the EFFECTIVE active (connected, or null) — never a stale
  // keyless provider. The renderer treats null as "no provider Active".
  return { activeProvider: effectiveByokActive(), providers };
}

// Runnable local CLIs (have a working adapter) — keep in sync with analyze.js.
const RUNNABLE_LOCAL = ['claude', 'antigravity', 'codex', 'grok', 'opencode', 'cursor'];

// THE single readiness concept used everywhere (banner, empty state, status pill,
// capture gate): ready when the active execution path can actually run.
//   Local  → a runnable local CLI is selected active AND detected installed.
//   BYOK   → a connected (key saved + validated) provider exists.
function executionReady() {
  const cfg = get();
  if ((cfg.executionMode || 'local') === 'local') {
    const id = cfg.localCli.activeId;
    if (!id || !RUNNABLE_LOCAL.includes(id)) return false;
    const r = getLocalCliResult(id);
    return Boolean(r && r.status === 'installed');
  }
  return Boolean(effectiveByokActive());
}

// True iff the *local* path is usable right now (active CLI detected installed).
function localExecutionReady() {
  const cfg = get();
  const id = cfg.localCli && cfg.localCli.activeId;
  if (!id || !RUNNABLE_LOCAL.includes(id)) return false;
  const r = getLocalCliResult(id);
  return Boolean(r && r.status === 'installed');
}

// When a BYOK provider connects, make it actually usable for capture: if the
// user is still in local mode AND local execution isn't ready, switch to BYOK
// (visible in the mode toggle) so executionReady + analyze use the working
// provider. Never overrides a ready local setup. This is the fix for "BYOK
// connected but New capture does nothing" — the gate only consults BYOK when
// executionMode !== 'local', and connecting BYOK never flipped the mode.
// Returns true if it switched the mode.
function adoptByokModeIfLocalUnready(prov) {
  const cfg = get();
  if ((cfg.executionMode || 'local') !== 'local') return false; // already byok
  if (localExecutionReady()) return false;                      // respect working local
  if (!byokConnected(prov)) return false;
  cfg.byok.activeProvider = prov;
  cfg.executionMode = 'byok';
  persist(cfg);
  return true;
}

// Renderer-safe view: no raw keys, exposes hasKey/model per provider.
function publicConfig() {
  const cfg = get();
  const active = cfg.activeProvider || 'anthropic';

  const providerStatus = {};
  for (const prov of PROVIDERS) {
    const d = cfg.providers[prov] || {};
    providerStatus[prov] = {
      hasKey: prov === 'ollama' ? Boolean(d.endpoint) : Boolean(d.apiKey),
      model:  d.model || '',
    };
  }

  const activeStatus = providerStatus[active] || { hasKey: false, model: '' };
  return {
    version:        cfg.version,
    activeProvider: active,
    executionMode:  cfg.executionMode || 'byok',
    isReady:        executionReady(), // single readiness source (Local CLI OR BYOK)
    byok:           publicByok(), // { activeProvider, providers: { name: { hasKey, baseUrl, maxTokens, model } } }
    localCli:       publicLocalCli(), // { activeId, detectedAt, clis: [...] } — no resolvedPath
    memoryModel:    { ...(cfg.memoryModel || { mode: 'same_as_chat', provider: null, model: '' }) },

    model:          activeStatus.model,
    hasApiKey:      activeStatus.hasKey,
    providerStatus, // { anthropic: { hasKey, model }, ... } — no raw keys
    hotkey:         cfg.hotkey,
    theme:          cfg.theme,
    themePreference: cfg.themePreference || 'system',
    prompt:         cfg.prompt,
    globalRules:    cfg.globalRules || '',
    notifications:  { ...(cfg.notifications || { sound: false, desktop: false }) },
  };
}

// Persist the user's global rules (Instructions / Rules box). Empty allowed.
function setGlobalRules(text) {
  const cfg = get();
  cfg.globalRules = typeof text === 'string' ? text : '';
  persist(cfg);
  return { ok: true };
}

// Merge notification toggles ({ sound?, desktop? }) and persist.
function setNotifications(fields) {
  const cfg = get();
  const cur = cfg.notifications || { sound: false, desktop: false };
  const next = { ...cur };
  if (fields && 'sound' in fields)   next.sound = Boolean(fields.sound);
  if (fields && 'desktop' in fields) next.desktop = Boolean(fields.desktop);
  cfg.notifications = next;
  persist(cfg);
  return { ok: true, notifications: next };
}

// ── Destructive: delete-my-data helpers (only ever called from an explicit,
// confirmed user action in MAIN — never automatically) ──────────────────────

// Remove every stored credential: BYOK keys + verified flags, and the legacy
// providers' keys/endpoint. Resets active selections to defaults. Other
// settings (theme, hotkey, prompt, notifications…) are left intact.
function clearAllCredentials() {
  const cfg = get();
  for (const p of BYOK_PROVIDERS) {
    cfg.byok.providers[p] = { ...freshByokProvider(p) }; // apiKey:null, verified:false, defaults
  }
  cfg.byok.activeProvider = 'anthropic';
  cfg.providers = freshProviders(); // clears legacy apiKey/endpoint for all providers
  cfg.activeProvider = 'anthropic';
  persist(cfg);
  return { ok: true };
}

// Reset ALL settings/preferences to defaults. Note: keys live in config.json, so
// this also clears stored credentials (a superset of clearAllCredentials).
function resetToDefaults() {
  const fresh = { ...DEFAULTS, providers: freshProviders(), byok: freshByok(),
    localCli: { activeId: null, lastDetection: null, models: {} },
    memoryModel: { mode: 'same_as_chat', provider: null, model: '' },
    modelCache: {}, notifications: { sound: false, desktop: false } };
  persist(fresh);
  return { ok: true };
}

module.exports = {
  PROVIDERS,
  THEMES,
  THEME_PREFERENCES,
  EXECUTION_MODES,
  BYOK_PROVIDERS,
  BYOK_DEFAULTS,
  load,
  get,
  save,
  setApiKey,
  getApiKey,
  setOllamaEndpoint,
  clearProviderKey,
  setModel,
  setActiveProvider,
  publicConfig,
  executionReady,
  hasKey,
  setGlobalRules,
  setNotifications,
  clearAllCredentials,
  resetToDefaults,
  // Execution mode / BYOK
  setExecutionMode,
  setMemoryModel,
  getByokProvider,
  setByokProvider,
  setByokActiveProvider,
  setByokVerified,
  byokConnected,
  effectiveByokActive,
  adoptByokModeIfLocalUnready,
  publicByok,
  // Local CLI detection
  saveLocalCliDetection,
  setLocalCliActive,
  setLocalCliModel,
  getLocalCliModel,
  setModelCache,
  getModelCache,
  getLocalCliResult,
  publicLocalCli,
  // Readiness / diagnostics
  localExecutionReady,
};
