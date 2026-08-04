<p align="center">
  <img src="build/icon.png" width="120" alt="TabDesk icon" />
</p>

<h1 align="center">TabDesk</h1>

<p align="center">
  A minimal Electron desktop shell for driving <a href="https://claude.com/claude-code">Claude Code</a>
  across many projects — a left tab rail of terminals, a grid view, and a live project preview.
</p>

---

## Features

- **Project tab rail** — every directory under your projects folder becomes a tab. The rail comes back in the order you left it (a project seen for the first time goes on top, most-recently-modified first). Opening one spawns a terminal already running `claude --permission-mode auto` in that project.
- **Grid view** — cycle from 1 up to 6 panels visible at once (`▦ Grid`) to watch several agents work side by side.
- **Activity flags** — background tabs pulse while their terminal streams output and turn green when they fall quiet ("your turn").
- **Live preview dock** — runs the active project (static HTML, Node, Python/Flask/FastAPI/Django, Rust, Go, …), finds the port it binds, and renders it in a webview. Hover any element to reveal its source.
- **Follows your desktop** — colours are derived from the live GTK theme (light/dark, accent, borders) and the UI speaks your system language. Both update live when you change them in system settings.
- **Themes** — the original neon look is kept as a preset in `themes/neon.json`; drop in more JSON files to add your own.
- **Screenshot** — capture the focused terminal panel to a PNG in `~/Pictures`.
- **System bar** — live Claude Code token usage (daily / weekly / total with cost estimate), plus CPU, RAM, and a clock.
- **Fullscreen** — `F11` or the toolbar button.

## Requirements

- **Linux** (X11). Native terminal embedding uses `xterm` and `xdotool`; GTK colour probing uses `python3-gi` (all pulled in by the `.deb`).
- **Node.js** 18+ and a C toolchain (`node-pty` is compiled on install).

## Getting started

```bash
npm install      # also rebuilds node-pty against Electron
npm start
```

### Install as a desktop app

```bash
npm run dist                        # builds dist/tabdesk_<version>_amd64.deb
sudo apt install ./dist/tabdesk_0.1.0_amd64.deb
```

TabDesk then appears in the application menu under Development and launches
standalone from `/opt/TabDesk`.

## Configuration

Projects are read from `~/claude-projects` (`PROJECTS_DIR` in `main.js`).

### Theme and language

Both default to `system` and are stored in `~/.config/TabDesk/settings.json`:

```json
{ "theme": "system", "language": "system" }
```

- **`theme`** — `system` derives the palette from the running GTK theme (probed
  through `python3-gi`, falling back to a neutral light/dark pair) or the `id` of
  any preset in `themes/`, e.g. `neon`.
- **`language`** — `system` follows `LANGUAGE`/`LANG`, or a code with a file in
  `i18n/` (`en`, `sv`).

A theme file carries a small `palette` (the engine derives the rest), plus
optional `tokens` / `terminal` overrides — see `themes/neon.json`.

### Native terminal embedding

Terminals are embedded `xterm` windows reparented into the panels via X11
(`term-embed.js`), which is why `xterm` and `xdotool` are runtime dependencies.
Set `EMBED_NATIVE = false` in `renderer/renderer.js` to use in-app xterm.js
instead (screenshottable, but no native window).

## Project layout

| File | Role |
| --- | --- |
| `main.js` | Electron main process — window, IPC, terminal (pty) lifecycle |
| `preload.js` | Sandboxed bridge exposing `window.api` to the renderer |
| `renderer/` | UI (`index.html`, `renderer.js`, `styles.css`, `ui.js` theme/i18n layer) |
| `preview-runner.js` | Detects and launches a project for the live preview |
| `preview-preload.js` | Element inspector injected into the preview webview |
| `usage-worker.js` | Off-thread scan of `~/.claude/projects` for token usage |
| `term-embed.js` | Native `xterm` embedding via X11 reparenting |
| `theme.js` | Theme engine — GTK probe, token derivation, presets |
| `themes/` | Theme presets (`neon.json`) |
| `i18n.js`, `i18n/` | Translations and locale detection |
| `settings.js` | Persisted preferences in `userData/settings.json` |
| `build/` | App icon (`icon.svg` source, `icon.png` used at runtime) |

## License

[MIT](LICENSE) © Jonaz Thern
