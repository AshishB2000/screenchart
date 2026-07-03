# Screenchart

Screenshot any chart or table, press a hotkey, get a plain-English explanation or an
auto-drawn chart — using local AI or your own API key.

> **Status:** early scaffolding. This repo currently implements only the **app shell and
> capture loop** — no AI, no networking. Drag-select a region and see the cropped image.

## Requirements

- [Node.js](https://nodejs.org/) 18+ and npm
- Desktop OS: Windows, macOS, or Linux (X11 recommended — see notes below)

## Run

```bash
npm install
npm start
```

A small status window appears showing the hotkey. Press it from any app to start a capture.

## How it works

1. Launch → a status window shows the global hotkey.
2. Press **Ctrl/Cmd+Shift+S** from anywhere → the screen dims with a frozen snapshot.
3. Drag a box around the region you want.
4. Release → a popup shows the cropped image, with a **Copy image** button.
5. Press **Escape** while selecting to cancel.

Internally, the full primary screen is captured first (the "frozen frame"), painted into the
overlay, and the cropped region is taken from that still image — so the overlay itself never
appears in the result.

## Platform notes

### macOS — Screen Recording permission

macOS requires **Screen Recording** permission, or captures come back **solid black**.

- On first capture, grant permission in **System Settings → Privacy & Security → Screen
  Recording**, then **restart the app**.
- In development you grant permission to the app launching Electron (your terminal or
  `Electron.app`), not to "Screenchart" — that only applies once the app is packaged.

If permission is missing, the status window shows instructions instead of a black capture.

### Linux — Wayland limitation

On **Wayland**, global hotkeys and screen capture are unreliable: the hotkey may silently fail
to register, and capture can trigger a portal picker instead of a silent grab. **An X11 session
is recommended.** The app detects Wayland and shows a warning in the status window. Full Wayland
portal support is out of scope for now.

### HiDPI / Retina

Captures are cropped from the actual returned bitmap resolution, so selections stay accurate on
Retina and Windows display-scaling (125–150%).

## Scripts

Developer/workflow helpers live in the **screenchart-dev skill** at
[`.claude/skills/screenchart-dev/scripts/`](.claude/skills/screenchart-dev/scripts/)
(POSIX bash, macOS/Linux). Claude Code auto-loads them as a skill when you set up
the dev environment, check build prerequisites, open a PR, or file an issue; you
can also run them by hand:

| Script | What it does |
|--------|--------------|
| `check-prereqs.sh` | Verify the build environment: Node 18+, npm, `gh` installed **and** authenticated, electron-builder. Exits non-zero if any required check fails. |
| `setup-workspace.sh` | Bootstrap a fresh clone: run the prereq check, `npm install`, then print next steps. |
| `create-pr.sh` | Push the current branch and open a PR into `main` via `gh` (refuses to run on `main`). Does not merge. |
| `create-issue.sh` | Open a GitHub issue in `AshishB2000/screenchart` via `gh`. |

```bash
bash .claude/skills/screenchart-dev/scripts/check-prereqs.sh
bash .claude/skills/screenchart-dev/scripts/setup-workspace.sh
bash .claude/skills/screenchart-dev/scripts/create-pr.sh                     # gh fills title/body from commits
bash .claude/skills/screenchart-dev/scripts/create-pr.sh "Title" "Body"       # or pass a title + body
bash .claude/skills/screenchart-dev/scripts/create-issue.sh "Title" "Body" --label bug
```

The scripts run from any directory (they resolve the repo root themselves).
`create-pr.sh` / `create-issue.sh` need the [`gh` CLI](https://cli.github.com/)
authenticated (`gh auth login`).

## Scope

Single primary display only. AI/API integration, configuration UI, multi-monitor support,
history, and installers are intentionally **not** included yet.
