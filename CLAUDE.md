# Screenchart

Screenshot anything on screen → press a hotkey → Screenchart analyzes the content and
responds in plain English. Local-first, model-agnostic, open source.

**Core principle:** the intelligence is in the prompt, not the plumbing. Compete on prompt
quality — invest in the prompt before adding code.

## Project Overview
- **What:** a screen tool. Drag a box around content; a vision model reads it and answers.
- **One mode — analysis.** The model looks at whatever is on screen (chart, table, dashboard,
  text, anything) and returns a plain-language analysis. One call; text is the product.
- **Audience:** launch crowd = developers / local-AI users wanting fast, private, no-key.
  Benefits most = non-technical people living in dashboards and spreadsheets.

## Tech Stack
- **Runtime:** Electron 33 (macOS-first; darwin, win32, linux in scope eventually)
- **Language:** plain JavaScript (no TypeScript, no bundler)
- **UI:** vanilla HTML + CSS + JS; no frontend framework
- **Screenshot / hotkey:** Electron `desktopCapturer` + `globalShortcut` (`Cmd/Ctrl+Shift+S`)
- **Secure key storage:** Electron `safeStorage` (OS keychain on macOS, DPAPI on Windows)
- **Config persistence:** JSON at `app.getPath('userData')/config.json`
- **Providers supported:** Anthropic, OpenAI, Gemini, OpenRouter, Ollama (local), Custom

## Architecture

### The capture loop
Hotkey → `startCapture()` → frozen frame via `desktopCapturer` → full-screen overlay dims
the screen → user drags a box → `capture:commit` IPC → cropped image sent to hub → model
analyzes it → analysis text shown in hub.

If no key is configured when hotkey fires, the hub opens instead and shows the inline setup
panel — capture never starts.

### Windows
| Window | File | Preload | Purpose |
|--------|------|---------|---------|
| Hub | `renderer/hub/` | `preload/hubPreload.js` | Main app window — captures, analysis results, history, settings |
| Overlay | `renderer/overlay/` | `preload/overlayPreload.js` | Full-screen dim + drag-to-select |
| Status | `renderer/status/` | `preload/statusPreload.js` | Small status/error bar |
| Setup (legacy) | `renderer/setup/` | `preload/setupPreload.js` | Standalone first-run window (kept but largely replaced by the hub inline panel) |

### Result surface
All results appear inside the hub window — no separate result popup. The hub's `#capture-view`
panel shows a thumbnail of the capture, the analysis text, follow-up chips, and a follow-up
input. A session history rail in the sidebar lists past captures (newest first); clicking one
restores its result.

### Single-window navigation
The hub hosts an **inline setup panel** (`#setup-panel`) — a fixed full-window overlay.
Main process sends `hub:show-setup` IPC → hub JS shows the panel. No second `BrowserWindow`
is opened for settings. The back button always hides the panel and returns to the hub view.

### IPC surface (main ↔ renderer)
| Channel | Direction | Handler | Purpose |
|---------|-----------|---------|---------|
| `hub:capture` | renderer → main | `ipcMain.on` | Trigger capture (gated on hasApiKey) |
| `hub:open` | renderer → main | `ipcMain.on` | Focus / create hub window |
| `setup:open` | renderer → main | `ipcMain.on` | Show inline setup panel |
| `setup:done` | renderer → main | `ipcMain.on` | Legacy: close standalone setup window |
| `hub:show-setup` | main → hub | `webContents.send` | Tell hub to show setup panel |
| `key:changed` | main → hub | `webContents.send` | Key saved/cleared — refresh badge |
| `hub:new-entry` | main → hub | `webContents.send` | New capture ready — hub adds loading entry |
| `hub:entry-result` | main → hub | `webContents.send` | Analysis result for a specific entry |
| `hub:retry` | hub → main | `ipcMain.on` | Re-analyze same crop without re-capturing |
| `hub:copy` | hub → main | `ipcMain.on` | Copy image to clipboard |
| `hub:copyText` | hub → main | `ipcMain.on` | Copy text to clipboard |
| `key:status` | renderer → main | `ipcMain.handle` | Returns `publicConfig()` (no raw key) |
| `key:save` | renderer → main | `ipcMain.handle` | Encrypt + save remote API key |
| `key:clear` | renderer → main | `ipcMain.handle` | Remove stored key |
| `local:save` | renderer → main | `ipcMain.handle` | Save Ollama endpoint (no key) |
| `shell:open` | renderer → main | `ipcMain.on` | Open URL in default browser |
| `capture:commit` | overlay → main | `ipcMain.on` | Deliver crop rect → triggers analysis |
| `capture:cancel` | overlay → main | `ipcMain.on` | Abort capture |
| `overlay:frame` | main → overlay | `webContents.send` | Send frozen frame data URL |
| `status:state` | main → status | `webContents.send` | Push hotkey + note text |

### Config (`src/config.js`) — main process only
- Schema lives in `DEFAULTS`; `sanitize()` whitelists fields before any write
- `publicConfig()` is the only renderer-safe view: strips `apiKeyEncrypted`, adds `hasApiKey`
  (true when encrypted key exists, OR when provider is `ollama` and endpoint is non-empty)
- Raw key never leaves main process — never logged, never sent to a renderer

## Coding Conventions
- Plain JS, `'use strict'` everywhere
- `contextIsolation: true`, `nodeIntegration: false` — all renderer↔main communication via
  `contextBridge` + IPC, never direct Node access from renderer
- `ipcRenderer.invoke` (returns a Promise) for anything that needs a response; `ipcRenderer.send`
  (fire-and-forget) for events
- `ipcMain.handle` (must return a value) for invoke handlers; `ipcMain.on` for fire-and-forget
- Renderer JS reads from `window.<bridgeName>.*` exposed by each window's preload
- No inline `style=` attributes in hub HTML — the hub's CSP is `style-src 'self'`, blocking them.
  Use CSS classes in `hub.css` instead

## File Placement Rules
```
main.js                    # app entry, IPC wiring, window management
src/
  capture.js               # desktopCapturer + crop helpers
  config.js                # config + safeStorage key management (main only)
  windows/
    hubWindow.js           # BrowserWindow factory for hub
    overlayWindow.js       # BrowserWindow factory for overlay
    resultWindow.js        # BrowserWindow factory for result (legacy, not opened)
    setupWindow.js         # BrowserWindow factory for legacy setup (kept for safety)
    statusWindow.js        # BrowserWindow factory for status bar
renderer/
  theme.css                # shared CSS custom properties (colours, radii, etc.)
  hub/
    index.html             # hub window HTML (includes inline #setup-panel overlay)
    hub.css                # hub styles (all .sp-* setup-panel styles live here too)
    hub.js                 # hub + setup-panel logic
  overlay/                 # drag-to-select overlay
  result/                  # legacy result window (not used; kept for safety)
  setup/                   # legacy standalone setup window (largely superseded)
  status/                  # small status / error bar
preload/
  hubPreload.js            # contextBridge for hub window
  overlayPreload.js        # contextBridge for overlay window
  resultPreload.js         # contextBridge for legacy result window (not used)
  setupPreload.js          # contextBridge for legacy setup window
  statusPreload.js         # contextBridge for status window
```

## UI and Design Rules
- Region-select overlay: full-screen frozen screenshot dims behind a drag-box selector.
- Hub: single window — no navigation opens a new `BrowserWindow`. Settings/setup show as an
  inline overlay panel inside the hub.
- Capture result: small thumbnail top-left, analysis text below, follow-up chips + input at bottom.
  Clicking the thumbnail opens a full-size lightbox.
- Session history rail in the hub sidebar lists captures (newest first); clicking restores that result.
- The setup panel back button is **always** visible — first-run users must be able to dismiss
  it without completing setup.
- Provider badge colors are CSS classes (not inline styles) because of the hub's CSP:
  `.sp-badge-anthropic`, `.sp-badge-openai`, `.sp-badge-gemini`, `.sp-badge-openrouter`,
  `.sp-badge-ollama`, `.sp-badge-custom` — defined in `hub.css`.
- Theming: dark/light toggle in hub header; `data-theme` attribute on `<html>`, CSS variables
  in `renderer/theme.css`.

## Security Rules
- API key encrypted via Electron `safeStorage` — **never plaintext, never logged, never sent
  to a renderer**.
- Renderers receive only `{ hasApiKey: boolean, provider, theme, … }` from `key:status` —
  the raw or encrypted key never leaves the main process.
- Key validation in the renderer: **format check only, no network calls**.
- Local/private is a core promise: no telemetry, no surprise network calls. Data only goes to
  the user's configured endpoint.
- Don't build out-of-scope features unprompted.

## Content Guidelines
- Output is plain-language and concrete (e.g. "Revenue's up 12%, but it's all one client —
  concentration risk."), not jargon. Lead with the insight.

## Testing and Quality
- **Priority test:** local vision model accuracy on real screenshots.
- No test framework wired yet — add one before expanding the AI/model layer.

## Commands
```bash
npm start          # run the Electron app
```
No build step — plain JS loaded directly by Electron.

## Out of scope (not yet — don't build unprompted)
Settings UI beyond the inline setup panel, multiple OSes (beyond dev on macOS), installer,
PDF/spreadsheet export, history persistence beyond the current session, auto-update, a website.
