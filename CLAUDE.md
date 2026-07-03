# Screenchart

Screenshot anything on screen → press a hotkey → Screenchart analyzes the content in plain
English and can draw the right chart or map from it. Local-first, model-agnostic, open source (MIT).

**Core principle:** the intelligence is in the prompt, not the plumbing — invest in prompt
quality before adding code. The model *extracts and classifies*; the app *does the math*
(deterministic, auditable — the model never writes a computed number).

## Project Overview
- **What:** drag a box around on-screen content; a vision model reads it and answers.
- **One mode — analysis.** The model returns plain-language analysis PLUS structured data; the
  app then computes metrics, writes a number-accurate headline, and offers charts/maps + export.
- **Follow-ups:** each capture is a conversation. The model is stateless, so follow-ups replay
  the full thread (system prompt + original prompt + screenshot + every prior turn) each turn.
- **Audience:** developers / local-AI users (fast, private, no-key); benefits non-technical
  people living in dashboards and spreadsheets most.

## Tech Stack
- **Runtime:** Electron 42 (macOS-first; darwin + win32 build targets, linux eventually).
- **Language/UI:** plain JavaScript (no TypeScript, no bundler); vanilla HTML/CSS/JS, no framework.
- **Screenshot/hotkey:** `desktopCapturer` + `globalShortcut` (default `CommandOrControl+Alt+S`
  → `⌘⌥S` on macOS; user-configurable).
- **Charts:** Chart.js 4 + plugins (treemap, sankey, matrix, financial, `@sgratzl` boxplot).
  **Maps:** Leaflet (OSM tiles — the one planned external network call).
- **Export:** `pdfmake` (PDF), `docx` (Word), `pptxgenjs` (PPT). **Logos:** `simple-icons`.
- **Key storage:** `safeStorage` (keychain/DPAPI). **Config:** JSON at `userData/config.json` (v2).
  **History:** threads + crops on disk under `userData` (`src/history.js`).

### Two execution modes (`config.executionMode`)
- **`local`** (default) — a **Local CLI** the user already installed. Runnable: Claude Code,
  Antigravity, Codex, Grok, OpenCode, Cursor. The app **detects and runs only — never installs**
  (the "Install" button just opens a vendor URL). Gemini CLI is retired (honest disabled entry).
- **`byok`** — Bring Your Own Key to a cloud API. Families: **anthropic, openai, gemini, gateway**
  (any OpenAI-compatible endpoint — OpenRouter/custom/local servers). Keys encrypted per-provider.

## Architecture

### The capture loop
Hotkey (or "New capture") → gate on `config.executionReady()` → `startCapture()` → frozen frame
via `desktopCapturer` on the **display under the cursor** → full-screen overlay dims that screen →
drag a box → `capture:commit` → main crops the frozen frame → the crop (base64 PNG data URL) is
saved to history, shown as a thumbnail, and sent to `analyze()`. If not ready (no CLI/key), the
hub opens to **Execution settings** instead — capture never starts.

### Image delivery
- **BYOK:** crop sent **inline as base64** in the HTTPS body (Anthropic `image` / OpenAI
  `image_url` / Gemini `inline_data`).
- **Local CLI:** crop written to a **temp file** under `userData/tmp/…`; its path is handed to the
  CLI via a prompt hint or a flag (`--add-dir`, `-i`).

### analyze → compute → display (`src/analyze.js`, `calc.js`, `headline.js`)
`analyze(dataUrl)` sends `buildSystemPrompt()` + image, expects ONLY a JSON envelope →
`parseReply()` validates against controlled vocabularies (drops off-list) into `extractedTable`
(raw numbers verbatim), `dataShape`, `columnRoles`, `suggestedCalculations`, number-free
`headline.angle`, `visualizations`, `geo`, `followups` → `calc.js` does the arithmetic →
`headline.js` composes the headline and inserts figures (model forbidden from writing numbers).

### Windows (all inline panels live in the hub; no extra BrowserWindow for settings)
| Window | Renderer | Preload → bridge | Factory (`src/windows/`) |
|--------|----------|------------------|--------------------------|
| Hub | `renderer/hub/` | `hubPreload` → `window.hub` | `hubWindow.js` |
| Overlay | `renderer/overlay/` | `overlayPreload` → `window.overlay` | `overlayWindow.js` |
| Status | `renderer/status/` | `statusPreload` → `window.screenchart` | `statusWindow.js` |
| About | `renderer/about/` | `aboutPreload` → `window.about` | `aboutWindow.js` |
| Permission | `renderer/permission/` | `permissionPreload` → `window.permission` | `permissionWindow.js` |

Settings/About/Permission are fixed full-window overlay panels inside the hub (`#settings-panel`
with `#ex-local-panel`/`#ex-byok-panel`, `#about-panel`, `#permission-panel`), shown via
`hub:open-settings`; back returns to the hub view.

### Result surface
Thumbnail (→ lightbox), headline + analysis, a chart or Leaflet map with a `⋯` menu
(Values/Periods/customize), follow-up chips + input, and report export (PDF/Word/PPT — charts
and maps). A disk-persisted history rail lists captures (newest first); clicking restores its thread.

### Code layout
- **Main:** `main.js` = entry/lifecycle/hotkey/capture loop/windows. Logic in `src/` modules
  (`analyze, calc, headline, capture, config, history, hotkey, localCli, localCliRun, models,
  icons, userPath`). **IPC** split into `src/ipc/*.js`, each exporting `register(deps)`, wired in
  `main.js`. Add new IPC to the matching `src/ipc` module, not `main.js`.
- **Renderer (hub):** many `<script>` files sharing one global scope (call-time resolution, so
  load order is irrelevant): `hub.js` (shell/state/error card), `renderResult.js` (result +
  chart-type picker), `chartRender.js` (buildChart), `chartControls.js` (Values/Periods/customize),
  `mapRender.js` (Leaflet), `reportExport.js` (export + map→PNG capture), `execMenu.js`,
  `settingsPanels.js` (Local CLI + BYOK), `customDropdown.js`, `geoMatch.js`.

### IPC surface (representative — full set in `src/ipc/*` + `main.js`)
Renderer→main: `invoke` (reply) or `send` (fire-and-forget); main→renderer: `webContents.send`.

| Area | Channels |
|------|----------|
| Capture | `capture:commit`/`:cancel`, `overlay:frame`, `hub:capture`, `hub:captureRegion` (map→PNG) |
| Results | `hub:new-entry`, `hub:entry-result`, `hub:followup`(+`-result`), `hub:retry`, `hub:saveChartOverrides` |
| Exec/BYOK | `exec:setMode`, `byok:saveProvider`/`:test`/`:activate`/`:revealKey`, `key:status`/`:save`/`:clear`/`:validate`/`:models`, `local:save`, `provider:activate`, `model:save`, `rules:set`, `memory:setModel` |
| Local CLI | `cli:detect`/`:detectOne`/`:setActive`/`:test`/`:models`/`:saveModel`, `models:list` |
| History/export | `history:load`/`:delete`, `data:delete`, `hub:history`, `hub:saveImage`/`:savePdf`/`:saveDocx`/`:savePptx`/`:captureReport`, `hub:copy`/`:copyText` |
| Theme/notif/hotkey | `theme:getPreference`/`:setPreference`/apply, `notifications:bootstrap`/`:set`, `hotkey:save`/`:label`, `hub:hotkey-state`, `hub:open`/`:open-settings`/`:show-permission`, `status:state`, `shell:open`, `provider:logos`/`agent:logos`, `permission:open-settings` |

### Config (`src/config.js`) — main process only, schema v2
`DEFAULTS` is the source of truth: `executionMode`, `activeProvider`, `byok` (per-provider
`{apiKey, baseUrl, maxTokens, model, verified}`), `localCli` (`{activeId, lastDetection, models}`),
`memoryModel` (integration point, no memory step yet), `modelCache`, `hotkey`,
`theme`/`themePreference`, `globalRules`, `notifications`. `sanitize()` whitelists plain fields;
keys/BYOK/CLI use dedicated setters. `publicConfig()`/`publicByok()` are the only renderer-safe
views — they add status booleans and **strip every raw/encrypted key**. `executionReady()` gates
capture. v1 flat config migrates to v2 on load.

## Coding Conventions
- Plain JS, `'use strict'` everywhere. `contextIsolation: true`, `nodeIntegration: false` — all
  renderer↔main via `contextBridge` + IPC, never direct Node from a renderer.
- `invoke`/`handle` for request/response; `send`/`on` for fire-and-forget. New handlers go in the
  matching `src/ipc/*` `register()`. Renderer reads `window.<bridge>.*` (hub → `window.hub`).
- Hub CSP is strict (`default-src 'none'; style-src 'self'; script-src 'self'; img-src data: file:
  <OSM hosts>`): **no inline `style=` in hub HTML** — use `hub.css` classes (JS `element.style.x`
  IS allowed and used).
- Local CLI execution is shell-free: `execFile`/`spawn` with an **args array, never `shell:true`**;
  no user/AI/config string ever becomes a command.

## File Placement
`main.js` → app/IPC wiring/windows. `src/` → main-process modules; `src/ipc/` → one file per area
(`register()`); `src/windows/` → BrowserWindow factories. `renderer/{hub,overlay,status,about,
permission}/` → windows (hub is the multi-`<script>` split above); `renderer/theme.css` → shared
CSS vars. `preload/` → one contextBridge per window. `scripts/` → build + `test-*.js` self-checks
(not shipped). `assets/`, `geo/` → icons + GeoJSON (fetched on postinstall).

## UI and Design
- Overlay dims the display under the cursor (multi-monitor aware) behind a drag-box selector.
- Single window: settings/about/permission are inline overlay panels, never a new window.
- Charts (Chart.js) for tabular data; Leaflet for genuinely geographic data (`map_bubble`/
  `map_choropleth`). Chart-type picker = Recommended / Selected / + More; grouped data supports
  Values/Periods and small multiples where it fits.
- Theming: system/light/dark (`themePreference`); `data-theme` on `<html>`, CSS vars in
  `theme.css`. Brand/badge colors are CSS classes (CSP forbids inline styles).

## Security
- Keys encrypted per-provider via `safeStorage` — **never plaintext, logged, or sent to a
  renderer** (raw or encrypted). Renderers get only `hasKey`/status. Renderer key validation is a
  **format check only, no network**.
- Local CLI: **detect and run only — NEVER install** (no `npm/brew/curl`, no shell). Detection
  resolves binaries on PATH + known bin dirs and runs `<bin> --version`.
- Local/private is a core promise: no telemetry, no surprise network calls — data goes only to the
  user's configured endpoint (or stays fully local with a local CLI). OSM tiles are the one
  declared external fetch, only when a map is shown.
- Don't build out-of-scope features unprompted.

## Content Guidelines
Plain-language, concrete, insight-first (e.g. "Revenue's up 12%, but it's all one client —
concentration risk."), not jargon. All figures are computed by the app.

## Testing and Commands
- **Priority test:** local vision model accuracy on real screenshots. Node self-checks in
  `scripts/test-*.js` (pure logic, no framework) via `npm test`; add one per non-trivial helper.

```bash
npm start          # run the app (no dev build step)
npm test           # scripts/test-*.js self-checks
npm run dist:mac   # macOS dmg (electron-builder)
npm run dist:win   # Windows installer/zip
npm run icons:verify   # verify logos vs installed simple-icons
```
`postinstall` fetches map GeoJSON (`scripts/download-geo.js`). Plain JS loads directly in dev; the
only "build" is packaging installers.

## Out of scope (don't build unprompted)
Installing CLIs for the user, a hosted/central-server web version, a marketing website,
spreadsheet export, and a full memory/summarization step (`memoryModel` config exists as an
integration point but nothing consumes it yet). Ask before adding runtime dependencies — prefer
stdlib / native platform features / already-installed deps.
