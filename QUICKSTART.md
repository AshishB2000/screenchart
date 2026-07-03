# Quickstart

From install to your first analysis in a few minutes.

## 1. Install
1. Download the latest macOS build from the
   [Releases page](https://github.com/AshishB2000/screenchart/releases).
2. Open the `.dmg` and drag Screenchart to Applications.
3. First launch shows macOS "Apple could not verify…" because the build isn't code-signed yet.
   To open it: right-click the app → **Open** → **Open** in the dialog.

## 2. Grant Screen Recording permission
The first capture triggers a macOS **Screen Recording** permission request (needed to grab the
region you select). Click **Open System Settings**, enable Screenchart under **Privacy & Security
→ Screen Recording**, then relaunch.

## 3. Connect an AI provider (or a CLI agent)
Screenchart is bring-your-own-key. In **Settings**, add a key for Anthropic, OpenAI, or Gemini,
or point it at a **gateway** (any OpenAI-compatible endpoint — OpenRouter, Ollama, or a custom
URL; Ollama uses an endpoint rather than a key).
Alternatively, use a local **CLI agent** you already have installed.

## 4. Capture and analyze
1. Press the capture shortcut from any app: **⌘⌥S** (configurable in Settings).
2. Drag a box around any chart, table, or data.
3. Get an instant plain-English analysis plus a visualization.

Your captures and history stay on your machine; see [PRIVACY.md](./PRIVACY.md) for what is sent
when you run an analysis (and note: API keys are stored unencrypted).

## Troubleshooting
- **Capture fails / "failed to get sources":** Screen Recording permission isn't granted — do
  step 2 and relaunch.
- **Provider error:** re-check the key in Settings and that the provider has quota (some free
  tiers have daily limits).
- **An Automation/"controlling" prompt appears:** it's from a CLI agent (e.g. Cursor) and is
  safe to deny.
