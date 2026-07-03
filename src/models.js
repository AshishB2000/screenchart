'use strict';

// Shared live model-list fetch. MAIN PROCESS ONLY.
// One path for both the header dropdown and the Execution mode settings pane, so
// they can never disagree. Keys stay in main and go in AUTH HEADERS — never in a
// URL/query string. CLI listing only ever runs the detection-resolved binary
// with a fixed args array (no shell). Every path degrades gracefully: callers
// fall back to cached/default on failure (see main.js models:list).

const { net } = require('electron');
const { spawn } = require('child_process');
const config = require('./config');

const TIMEOUT_MS = 12000;
const BYOK = ['anthropic', 'openai', 'gemini', 'gateway'];

const ok = (models) => ({ ok: true, models });
const fail = (errorType) => ({ ok: false, errorType, models: [] });

async function getJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await net.fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    // Keep the error body (capped) so failures can be logged with a real cause.
    let json = null, bodyText = '';
    if (res.ok) json = await res.json();
    else { try { bodyText = (await res.text()).slice(0, 300); } catch (_) {} }
    return { status: res.status, json, bodyText };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, json: null, networkError: true, bodyText: String((err && err.message) || err) };
  }
}

// Log the underlying failure cause to the MAIN log (never reaches the renderer).
function logFail(provider, r) {
  const detail = String(r.bodyText || '').replace(/\s+/g, ' ').slice(0, 200);
  console.warn(`[models] ${provider} list failed: status=${r.status || 'net'} ${detail}`);
}

// Derive a clean {id,label}[] from each provider's response. Names are NOT
// hardcoded — only coarse relevance filters (chat/vision-capable) are applied.
function parseByok(provider, json) {
  if (provider === 'anthropic') {
    return (json.data || [])
      .filter(m => /claude-(opus|sonnet|haiku)/i.test(m.id))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .map(m => ({ id: m.id, label: m.display_name || m.id }));
  }
  if (provider === 'gemini') {
    return (json.models || [])
      .filter(m => /gemini/i.test(m.name || '') &&
        (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: (m.name || '').replace('models/', ''), label: m.displayName || m.name }));
  }
  // openai + OpenAI-compatible gateway share the {data:[{id}]} shape. For the
  // generic gateway we can't know the naming, so list everything; for OpenAI we
  // keep the vision-capable families.
  const data = json.data || [];
  const rows = provider === 'openai'
    ? data.filter(m => /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|o1|o3|o4)/i.test(m.id))
    : data;
  return rows.map(m => ({ id: m.id, label: m.id })).sort((a, b) => b.id.localeCompare(a.id));
}

async function fetchByokModels(provider) {
  const e = config.getByokProvider(provider); // { apiKey, baseUrl, model } — main only
  const baseUrl = (e.baseUrl || '').replace(/\/+$/, '');
  if (!e.apiKey) return fail('no_key');
  if (provider === 'gateway' && !baseUrl) return fail('no_key');

  let url, headers;
  if (provider === 'anthropic') {
    url = `${baseUrl}/v1/models`;
    headers = { 'x-api-key': e.apiKey, 'anthropic-version': '2023-06-01' };
  } else if (provider === 'gemini') {
    url = `${baseUrl}/models`;                       // key in HEADER, never the URL
    headers = { 'x-goog-api-key': e.apiKey };
  } else {                                            // openai or gateway (baseUrl already includes /v1)
    url = `${baseUrl}/models`;
    headers = { authorization: `Bearer ${e.apiKey}` };
  }

  const r = await getJson(url, headers);
  if (r.status === 401 || r.status === 403) { logFail(provider, r); return fail('auth'); }
  // Gemini signals a bad/missing key with 400 INVALID_ARGUMENT ("API key not valid"),
  // not 401 — treat that as auth so the user gets the right message.
  if (provider === 'gemini' && r.status === 400 && /api[_ ]?key|invalid/i.test(r.bodyText || '')) {
    logFail(provider, r); return fail('auth');
  }
  if (r.networkError) { logFail(provider, r); return fail('network'); }
  if (!r.json) { logFail(provider, r); return fail('provider'); }
  return ok(parseByok(provider, r.json));
}

// `agy models` — one model per stdout line. We strip bullet/decoration and skip
// obvious header lines; any failure → typed error so the caller shows Default.
// NOTE: assumes the documented one-per-line output; unverified where agy is absent.
function parseAgyModels(stdout) {
  return (stdout || '')
    .split('\n')
    .map(l => l.replace(/^[\s>*\-•]+/, '').trim())
    .filter(l => l && !/^(models?|available models?|loading|usage:)/i.test(l))
    .map(l => ({ id: l, label: l }));
}

function fetchCliModels(cliId) {
  // Only Antigravity exposes a non-interactive list. Claude Code (and others)
  // have no such command — honest "Default (CLI config)".
  if (cliId !== 'antigravity') return Promise.resolve(ok([]));
  const rec = config.getLocalCliResult('antigravity');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return Promise.resolve(fail('not_installed'));

  return new Promise((resolve) => {
    let out = '', settled = false, child;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    try { child = spawn(bin, ['models'], { windowsHide: true }); }
    catch (_) { return resolve(fail('provider')); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} done(fail('network')); }, TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => done(fail('provider')));
    child.on('close', (code) => done(code === 0 ? ok(parseAgyModels(out)) : fail('provider')));
  });
}

// Unified entry: provider name → HTTP fetch; CLI id → CLI list.
function listModels(target) {
  return BYOK.includes(target) ? fetchByokModels(target) : fetchCliModels(target);
}

module.exports = { listModels, BYOK };
