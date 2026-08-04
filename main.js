const { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog,
        desktopCapturer, screen, clipboard } = require('electron');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const pty = require('node-pty');
const previewRunner = require('./preview-runner');
const appRunner = require('./app-runner');
const termEmbed = require('./term-embed');
const theme = require('./theme');
const i18n = require('./i18n');
const settings = require('./settings');
const model = require('./model');
const agents = require('./agents');
const portable = require('./portable');
const updater = require('./updater');
const usageLimits = require('./usage-limits');
const tray = require('./tray');
const syncConfig = require('./sync/config');
const syncTransport = require('./sync/transport-sftp');
const syncBundle = require('./sync/bundle');
const syncFiles = require('./sync/files');
const syncWatch = require('./sync/watch');
const syncTrust = require('./sync/trust');
const syncPull = require('./sync/pullwatch');
const syncKeys = require('./sync/keys');
const syncInvite = require('./sync/invite');

// Demo/testing hooks, unset in normal use. TABDESK_PROJECTS_DIR points the rail
// at a scratch set of projects (screenshots, trying layout changes against a
// known set) without touching the real one; TABDESK_START_CMD gives those tabs
// a command other than a live Claude session.
const PROJECTS_DIR = process.env.TABDESK_PROJECTS_DIR || path.join(os.homedir(), 'claude-projects');
const DEMO_START_CMD = process.env.TABDESK_START_CMD || null;

// Aggregate Claude Code usage off the main thread.
function scanUsage() {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'usage-worker.js'), {
        workerData: { dir: path.join(os.homedir(), '.claude', 'projects') },
      });
    } catch (_) { return resolve(null); }
    worker.once('message', (msg) => { resolve(msg); worker.terminate(); });
    worker.once('error', () => resolve(null));
  });
}

// Live CPU% via idle/total deltas between calls.
let prevCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idleD = 0, totalD = 0;
  for (let i = 0; i < now.length; i++) {
    const a = prevCpu[i].times, b = now[i].times;
    idleD += b.idle - a.idle;
    totalD += (b.user + b.nice + b.sys + b.idle + b.irq) -
              (a.user + a.nice + a.sys + a.idle + a.irq);
  }
  prevCpu = now;
  return totalD > 0 ? Math.round(100 * (1 - idleD / totalD)) : 0;
}

// Track one pty per terminal id.
const terminals = new Map();

// Currently resolved theme + language, shared with the renderer over IPC.
let activeTheme = null;
let activeI18n = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // Launch windowed, NOT fullscreen (per requirement).
    fullscreen: false,
    backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // for the interactive project preview
    },
  });

  // webviewTag is on for the preview dock, and a <webview> brings its own
  // webPreferences with it. That makes "can attach a webview" the same thing as
  // "can choose whether node is available", so the choice is made here instead
  // of trusting whatever asked for the attach. The only preload that may ride
  // along is the inspector we ship; anything else is dropped rather than
  // refused, so a legitimate attach still succeeds without one.
  const PREVIEW_PRELOAD = path.join(__dirname, 'preview-preload.js');
  // Compared as a resolved path, not as the string that arrived: Electron has
  // handed this over as both `preloadURL` and `preload`, and as both a file://
  // URL and a plain path, depending on version. An exact string match would
  // silently drop our own inspector on the version that spells it differently,
  // turning a hardening into a broken feature.
  const isOurPreload = (v) => {
    const s = String(v || '');
    if (!s) return false;
    try { return path.resolve(s.startsWith('file://') ? new URL(s).pathname : s) === PREVIEW_PRELOAD; }
    catch (_) { return false; }
  };
  win.webContents.on('will-attach-webview', (event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    const asked = webPreferences.preloadURL || webPreferences.preload;
    if (asked && !isOurPreload(asked)) {
      delete webPreferences.preloadURL;
      delete webPreferences.preload;
    }
  });

  // Hide the default menu bar for a cleaner look; F11 still toggles fullscreen below.
  win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // F11 toggles fullscreen.
  //
  // Ctrl/Cmd+R and F5 are swallowed. The default menu is hidden, not gone, so
  // its Reload accelerator is still live — and a reload is not a refresh in this
  // app: the page comes back empty, every tab is gone, and the terminals behind
  // them are orphaned (see did-start-navigation below). preventDefault() here also
  // cancels the menu shortcut, which is what makes it catchable at all.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
      return;
    }
    const key = String(input.key).toLowerCase();
    if (key === 'f5' || ((input.control || input.meta) && key === 'r')) event.preventDefault();
  });

  // A reload can still arrive by a route the keys don't cover (devtools, a
  // renderer crash), and it leaves main holding every embed the old page made:
  // those xterms stay mapped over the new page, which knows nothing about them
  // and will never place or hide them again. Worse, tab ids restart at t1, so
  // the new page's first tabs collide with the survivors — create() sees the id
  // already registered, spawns nothing, and the tab drives the previous page's
  // terminal, showing another project's session. Nothing can hand those windows
  // back to a page that has forgotten them, so they go with it.
  //
  // The signal has to be a MAIN-FRAME navigation. `did-start-loading` is the tab
  // spinner, and Chromium counts the preview <webview>'s load as this window's
  // loading too — hooking it killed every terminal the moment Preview was
  // pressed, sessions and all, while the page went on believing its tabs were
  // live, so selecting one showed a blank panel with nothing left to recreate.
  // The guest's navigation arrives here with isMainFrame false; only the page
  // itself being replaced is true.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) termEmbed.killAll();
  });

  return win;
}

// ---- "New tab" project picker ---------------------------------------------
//
// A real top-level window, not an in-page overlay: the embedded terminals are
// native X windows stacked above the page, so any DOM modal would be covered by
// whichever terminal happens to be open behind it.
//
// The window resolves exactly once — with the choice, or with null if it is
// closed — and the pending resolver is keyed by its webContents so two pickers
// can never hand each other's answer back.
const pickerPending = new Map();

function openProjectPicker(parent) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 620,
      height: 700,
      minWidth: 460,
      minHeight: 420,
      show: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
      title: 'TabDesk',
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'new-project.html'));
    win.once('ready-to-show', () => win.show());

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      pickerPending.delete(win.webContents.id);
      resolve(value);
    };
    pickerPending.set(win.webContents.id, (value) => {
      finish(value);
      if (!win.isDestroyed()) win.close();
    });
    // Closing the window with no choice made counts as a cancel.
    win.on('closed', () => finish(null));
  });
}

// A project name becomes a directory under PROJECTS_DIR, so it may not carry a
// path of its own — the created directory has to stay inside PROJECTS_DIR.
function createProject(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return { ok: false, error: 'empty' };
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) return { ok: false, error: 'invalid' };

  const full = path.join(PROJECTS_DIR, name);
  if (path.dirname(path.resolve(full)) !== path.resolve(PROJECTS_DIR)) {
    return { ok: false, error: 'invalid' };
  }
  if (fs.existsSync(full)) return { ok: false, error: 'exists' };
  try {
    fs.mkdirSync(full, { recursive: true });
    return { ok: true, name, path: full };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ---- Projects the user closed ---------------------------------------------
//
// The rail is built from the project directories on disk, so closing a tab with
// the × only emptied it until the next start — the directory was still there and
// the tab came back. The choice is remembered here instead, as a list of paths
// the rail skips. It is not a hide-forever: the picker still lists them, and
// opening one is what clears the mark, so nothing needs a separate "unhide".
function closedProjects() {
  const list = settings.get('closedProjects');
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

function setProjectClosed(dir, closed) {
  if (typeof dir !== 'string' || !dir) return;
  const set = new Set(closedProjects());
  // Only what the rail rebuilds is worth remembering: a folder opened from
  // elsewhere ("Other folder…") is never listed at start, so closing its tab
  // has nothing to suppress and would just leave a dead entry behind.
  if (closed) {
    if (path.dirname(path.resolve(dir)) !== path.resolve(PROJECTS_DIR)) return;
    set.add(dir);
  } else {
    set.delete(dir);
  }
  settings.set('closedProjects', [...set]);
}

// ---- The order the rail was left in -----------------------------------------
//
// The rail is built from directories on disk, and it used to be sorted by mtime
// on every start — so a night of agents writing files handed you a different
// rail in the morning than the one you closed. Position is the whole point of
// this rail (a tab hoists to the top when it goes green), and a position that
// is forgotten every restart is not a position.
//
// The renderer writes the order down whenever the rail changes; a start reads
// it back. Only what the rail rebuilds is worth keeping, so this drops folders
// opened from elsewhere for the same reason setProjectClosed does. Directories
// that have since been deleted or renamed fall out by themselves: the next save
// only lists tabs that actually exist.
function projectOrder() {
  const list = settings.get('projectOrder');
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

function setProjectOrder(paths) {
  if (!Array.isArray(paths)) return;
  const root = path.resolve(PROJECTS_DIR);
  const seen = new Set();
  const next = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p || seen.has(p)) continue;
    if (path.dirname(path.resolve(p)) !== root) continue;
    seen.add(p);
    next.push(p);
  }
  settings.set('projectOrder', next);
}

// ---- Export / import of the portable "light layer" ------------------------
//
// Its own top-level window, for the same reason the picker is one: the
// embedded terminals are native X windows stacked above the page, so an
// in-page modal would sit behind whichever one is open.
//
// The bundle being imported never crosses to the renderer — main holds it
// while the window shows the diff, and drops it when the window closes. The
// renderer only ever sees an inventory and a plan.
let portableWin = null;
const pendingBundles = new Map();

function openPortableWindow(parent) {
  if (portableWin && !portableWin.isDestroyed()) { portableWin.focus(); return portableWin; }

  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 760,
    height: 700,
    minWidth: 560,
    minHeight: 460,
    show: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'portable-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'portable.html'));
  win.once('ready-to-show', () => win.show());
  // Read the id now: webContents is gone by the time 'closed' fires.
  const contentsId = win.webContents.id;
  win.on('closed', () => {
    pendingBundles.delete(contentsId);
    if (portableWin === win) portableWin = null;
  });

  portableWin = win;
  return win;
}

// ---- Settings --------------------------------------------------------------
//
// Theme and language have had handlers in main and methods on the preload since
// the beginning, but nothing in the renderer ever called them — they could only
// follow the desktop. This window is where they finally get a surface, and
// where the sync configuration lands in the next phase.
//
// Not modal, unlike the picker: it should be possible to leave settings open and
// watch a theme land on the tabs behind it.
let settingsWin = null;

function openSettingsWindow(parent) {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return settingsWin; }

  const win = new BrowserWindow({
    parent,
    modal: false,
    width: 620,
    height: 560,
    minWidth: 520,
    minHeight: 420,
    show: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (settingsWin === win) settingsWin = null; });

  settingsWin = win;
  return win;
}

// ---- Updates ---------------------------------------------------------------
//
// A background check asks the CDN's apt index what's published and tells the
// renderer, which raises a chip in the system bar. Everything privileged lives
// in updater.js; this is the window and the plumbing around it.
let updateWin = null;
let updateState = null;     // last check result, or null before the first one
let updateBusy = false;     // an install is in flight

function openUpdateWindow(parent) {
  if (updateWin && !updateWin.isDestroyed()) { updateWin.focus(); return updateWin; }

  const win = new BrowserWindow({
    parent,
    modal: false,   // unlike the picker: an update can download while you work
    width: 560,
    // Snug for the resting state; the progress bar, status line and dpkg output
    // all appear inside this, pushing the pinned footer down as they arrive.
    height: 360,
    minWidth: 460,
    minHeight: 320,
    show: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'update.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (updateWin === win) updateWin = null; });

  updateWin = win;
  return win;
}

// Ask apt what's published, remember it, and let the main window know.
async function checkForUpdate(win, options) {
  try {
    updateState = await updater.check(options);
  } catch (err) {
    console.warn('[update] check failed:', String(err.message || err));
    return { ok: false, error: String(err.message || err) };
  }
  if (win && !win.isDestroyed()) win.webContents.send('update:available', updateState);
  return { ok: true, state: updateState };
}

// ---- Theme + language plumbing --------------------------------------------

// Re-resolve the active theme and push it to the renderer. Called on startup,
// when the user picks a theme, and whenever the desktop's theme changes.
// Every window, not just the one that asked. The picker, the sync window and the
// update window all subscribe to these in their preloads, but only the main
// window was ever sent them, so they sat in whatever colours they opened in. It
// shows worst in settings: you pick a theme *in that window* and everything
// except the window you are looking at repaints.
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send(channel, payload);
  }
}

async function applyTheme(win) {
  activeTheme = await theme.resolve(settings.get('theme'));
  termEmbed.setTheme(activeTheme.terminal);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setBackgroundColor(activeTheme.tokens.bg);
  }
  broadcast('theme:changed', activeTheme);
  return activeTheme;
}

function applyLanguage(win) {
  activeI18n = i18n.resolve(settings.get('language'));
  broadcast('i18n:changed', activeI18n);
  return activeI18n;
}

// Watch the desktop for theme changes. nativeTheme covers the light/dark
// preference; gsettings monitor catches a full GTK theme swap (new colours
// without a light/dark flip), which nativeTheme never reports.
function watchDesktopTheme(win) {
  const refresh = () => {
    theme.invalidate();
    if (settings.get('theme') === 'system') applyTheme(win);
  };
  nativeTheme.on('updated', refresh);

  const schemas = ['org.cinnamon.desktop.interface', 'org.gnome.desktop.interface'];
  const monitors = schemas.map((schema) => {
    try {
      const p = spawn('gsettings', ['monitor', schema], { stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (buf) => {
        if (/gtk-theme|color-scheme|accent-color/.test(String(buf))) refresh();
      });
      p.on('error', () => { /* gsettings missing; nativeTheme still works */ });
      return p;
    } catch (_) {
      return null;
    }
  });
  app.on('will-quit', () => monitors.forEach((p) => p && p.kill()));
}

// ---- Screenshots -----------------------------------------------------------
//
// Capture path for embedded native terminals.
//
// capturePage() renders the window's OWN Chromium surface, and an embedded
// terminal is a separate X11 window stacked above that surface (see
// term-embed.js) — it is simply not in that picture, so a capturePage() shot of
// a native pane comes back as the empty panel underneath. desktopCapturer sees
// what the compositor sees, terminals included.
//
// The source has to be the SCREEN, not our own window. desktopCapturer will
// hand out a window source too, and from another process that one does contain
// the terminals — but asked for the window it lives in, Chromium answers with
// its own compositor surface, which has the same blind spot capturePage() has.
// The screen is a genuine X11 grab, so the terminals are in it.
//
// The cost of going through the screen is that it captures what is actually on
// display: anything covering the panel is captured instead of the panel. The
// app is normally on top when this runs (the user just clicked a button in it),
// and moveTop() makes that hold in the cases where it isn't.
//
// `rect` is in CSS pixels relative to the window's content area — the units
// getBoundingClientRect() hands the renderer.
async function captureEmbedRegion(win, rect) {
  win.moveTop();
  await new Promise((resolve) => setTimeout(resolve, 150));   // let it repaint

  const content = win.getContentBounds();          // screen coords, DIP
  const display = screen.getDisplayMatching(content);
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const shot = (sources.find((s) => String(s.display_id) === String(display.id))
                || sources[0] || {}).thumbnail;
  if (!shot || shot.isEmpty()) return null;
  return cropRegion(shot, {
    ...rect,
    x: content.x + rect.x - display.bounds.x,
    y: content.y + rect.y - display.bounds.y,
  }, display.size.width, display.size.height);
}

// Cut `rect` — DIP, relative to a `w`x`h` DIP area — out of a capture of that
// area. Ask for a size, get a size: the capture backend may hand back something
// other than the thumbnailSize we requested, so the DIP -> captured pixel
// factor comes from the image we actually got, not from the display's scale.
function cropRegion(image, rect, w, h) {
  const size = image.getSize();
  const kx = size.width / w;
  const ky = size.height / h;
  const clamp = (v, max) => Math.max(0, Math.min(Math.round(v), max));
  const x = clamp(rect.x * kx, size.width - 1);
  const y = clamp(rect.y * ky, size.height - 1);
  return image.crop({
    x,
    y,
    width: Math.max(1, clamp(rect.width * kx, size.width - x)),
    height: Math.max(1, clamp(rect.height * ky, size.height - y)),
  });
}

app.whenReady().then(async () => {
  // Resolve before the first window so it opens in the right colours.
  activeTheme = await theme.resolve(settings.get('theme'));
  activeI18n = i18n.resolve(settings.get('language'));
  termEmbed.setTheme(activeTheme.terminal);

  const win = createWindow();
  watchDesktopTheme(win);
  tray.init(win, activeI18n.strings);

  // Sync boot payload: the renderer needs theme + strings before first paint,
  // otherwise the UI flashes untranslated in the wrong colours.
  ipcMain.on('app:boot', (event) => {
    event.returnValue = {
      theme: activeTheme,
      i18n: activeI18n,
      settings: settings.all(),
      model: { list: model.list(), global: model.globalDefault(), byProject: model.allFor() },
      agents: { list: agents.list(), byProject: agents.allFor(), fallback: agents.DEFAULT_ID },
      demoStartCmd: DEMO_START_CMD,
    };
  });

  // ---- Claude model, per project ----
  ipcMain.handle('model:list', () => model.list());
  ipcMain.handle('model:global', () => model.globalDefault());
  ipcMain.handle('model:get', (event, projectPath) => model.getFor(projectPath));
  ipcMain.handle('model:set', (event, { path: projectPath, id }) => model.setFor(projectPath, id));

  // ---- Which CLI a project starts (Claude Code, another agent, plain shell) ----
  // The list is re-read rather than cached in the renderer: an agent installed
  // while TabDesk runs should turn up the next time the menu opens.
  ipcMain.handle('agents:list', () => agents.list());
  ipcMain.handle('agents:get', (event, projectPath) => agents.getFor(projectPath));
  ipcMain.handle('agents:set', (event, { path: projectPath, id }) => agents.setFor(projectPath, id));

  // What "Default" resolves to can change under us (an editor, `claude config`).
  const unwatchModel = model.watchGlobal((id) => {
    if (!win.isDestroyed()) win.webContents.send('model:global-changed', id);
  });
  app.on('will-quit', unwatchModel);

  // Copying a pairing string to the clipboard. Goes through main rather than
  // navigator.clipboard: these windows are file:// pages, where the async
  // clipboard API is not something to rely on.
  ipcMain.handle('clipboard:write', (event, text) => {
    const str = String(text || '');
    if (!str) return false;
    clipboard.writeText(str);
    return true;
  });

  ipcMain.handle('theme:list', () => theme.list());
  ipcMain.handle('theme:set', async (event, id) => {
    settings.set('theme', id);
    return applyTheme(win);
  });

  ipcMain.handle('i18n:list', () => i18n.list());
  ipcMain.handle('language:set', (event, code) => {
    settings.set('language', code);
    const next = applyLanguage(win);
    tray.setStrings(next.strings);
    return next;
  });

  // ---- Tray ----
  // The renderer owns the tab list; this is the mirror it pushes on every
  // add / close / rename / switch. The tray menu is rebuilt from it.
  ipcMain.on('tray:tabs', (event, payload) => tray.setTabs(payload));

  // Embedded native terminal windows (xterm) reparent into this window (X11).
  win.once('ready-to-show', () => termEmbed.init(win));
  termEmbed.init(win);
  termEmbed.setReadyNotifier((id) => {
    if (!win.isDestroyed()) win.webContents.send('embed:ready', { id });
  });
  // Drives the rail's busy/done dots for embedded terminals, the way pty data
  // does for the xterm.js backend.
  termEmbed.setActivityNotifier((id) => {
    if (!win.isDestroyed()) win.webContents.send('embed:activity', { id });
  });

  // ---- Embedded native terminal lifecycle ----
  // Opening a tab is not a passive act here: it starts the configured agent —
  // by default `claude --permission-mode auto` — with the project as its
  // working directory. For a directory that arrived over sync, that points an
  // auto-approving agent at somebody else's files. CLAUDE.md and .claude/ are
  // kept out of file sync for exactly this reason (sync/manifest.js), but the
  // rest of the tree is still material the agent will read and act on, so the
  // same question is asked here as before Run and Preview.
  ipcMain.on('embed:create', async (event, { id, cwd, startCmd }) => {
    if (cwd && !(await allowRun(BrowserWindow.fromWebContents(event.sender), cwd, 'terminal'))) {
      if (!win.isDestroyed()) win.webContents.send('term:declined', { id });
      return;
    }
    termEmbed.create(id, { cwd, startCmd });
  });
  ipcMain.on('embed:place', (event, { id, rect }) => termEmbed.place(id, rect));
  ipcMain.on('embed:hide', (event, { id }) => termEmbed.hide(id));
  ipcMain.on('embed:focus', (event, { id }) => termEmbed.focus(id));
  // Dropped file paths, already quoted by the renderer. invoke rather than send:
  // the drop is silent when the terminal can't take it (focus went elsewhere,
  // window still starting), and the renderer says so rather than looking broken.
  ipcMain.handle('embed:insert', (event, { id, text }) =>
    termEmbed.insert(id, String(text || '')));
  ipcMain.on('embed:kill', (event, { id }) => termEmbed.kill(id));

  // ---- Terminal lifecycle over IPC ----

  // List project directories under PROJECTS_DIR in the order the rail was last
  // left in, with anything new since then on top, most-recently-modified first.
  // With nothing remembered yet — first start after an upgrade — every project
  // counts as new, which is exactly the old mtime order.
  // `closed` carries the user's × on that tab: the rail leaves those out, the
  // picker still offers them (see closedProjects below).
  ipcMain.handle('projects:list', () => {
    try {
      const closed = new Set(closedProjects());
      const rank = new Map(projectOrder().map((p, i) => [p, i]));
      return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const full = path.join(PROJECTS_DIR, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* skip */ }
          return { name: e.name, path: full, mtime, model: model.getFor(full), closed: closed.has(full) };
        })
        .sort((a, b) => {
          const ra = rank.has(a.path) ? rank.get(a.path) : -1;
          const rb = rank.has(b.path) ? rank.get(b.path) : -1;
          if (ra === -1 && rb === -1) return b.mtime - a.mtime;
          if (ra === -1) return -1;
          if (rb === -1) return 1;
          return ra - rb;
        });
    } catch (_) {
      return [];
    }
  });

  // Closing a tab is a decision about the rail, so it has to outlive the
  // session; opening the project again takes it back.
  ipcMain.on('projects:closed', (event, { path: dir, closed }) => setProjectClosed(dir, closed));

  // The rail as it stands, top first. Sent debounced by the renderer, so this
  // is a whole-list replace rather than a diff — the page is the only thing
  // that knows the order, and a partial update could only disagree with it.
  ipcMain.on('projects:order', (event, { paths }) => setProjectOrder(paths));

  // ---- New tab: pick an existing project, or create one ----
  ipcMain.handle('projects:pick', () => openProjectPicker(win));

  ipcMain.on('picker:done', (event, choice) => {
    const done = pickerPending.get(event.sender.id);
    if (done) done(choice || null);
  });

  ipcMain.handle('projects:create', (event, name) => createProject(name));

  // Escape hatch for a project that doesn't live under ~/claude-projects.
  ipcMain.handle('projects:browse', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(owner, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: fs.existsSync(PROJECTS_DIR) ? PROJECTS_DIR : os.homedir(),
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    return { name: path.basename(dir), path: dir, model: model.getFor(dir) };
  });

  // ---- Portable state: export / import ----
  // Parented to whoever asked, not always the main window: it opens from
  // Settings now, and a modal owned by a window behind Settings would sit
  // behind it too, blocking a window the user cannot see is blocked.
  ipcMain.handle('portable:open', (event) => {
    openPortableWindow(BrowserWindow.fromWebContents(event.sender) || win);
    return true;
  });
  ipcMain.on('portable:close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner && !owner.isDestroyed()) owner.close();
  });

  ipcMain.handle('portable:scan', () => {
    try { return { ok: true, scan: portable.scan() }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('portable:export', async (event, slugs) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showSaveDialog(owner, {
      defaultPath: path.join(app.getPath('documents') || os.homedir(), portable.suggestedName()),
      filters: [{ name: 'TabDesk bundle', extensions: ['tabdesk'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const bundle = portable.buildBundle({ slugs: Array.isArray(slugs) ? slugs : null });
      const written = portable.writeBundle(res.filePath, bundle);
      return {
        ok: true,
        path: written.path,
        bytes: written.bytes,
        projects: bundle.projects.length,
        memoryFiles: bundle.projects.reduce((n, p) => n + p.memory.length, 0),
      };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // Parse a bundle and hand back its diff. The bundle itself stays here.
  ipcMain.handle('portable:open-bundle', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(owner, {
      properties: ['openFile'],
      filters: [
        { name: 'TabDesk bundle', extensions: ['tabdesk'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try {
      const bundle = portable.readBundle(res.filePaths[0]);
      pendingBundles.set(event.sender.id, bundle);
      return { ok: true, file: res.filePaths[0], plan: portable.plan(bundle) };
    } catch (err) {
      pendingBundles.delete(event.sender.id);
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- The same bundle, over the network ----
  //
  // These deliberately land in the same place a file-picked bundle does:
  // pendingBundles + portable.plan(). The review step and everything after it
  // is shared, so a bundle off a server can never take a shortcut past the
  // screen that shows what it would overwrite.
  const syncFail = (err) => ({
    ok: false,
    code: err.code || 'other',
    detail: String(err.message || err),
    missing: err.missing,
  });

  ipcMain.handle('sync:push-bundle', async (event, slugs) => {
    try { return await syncBundle.push(slugs); }
    catch (err) { return syncFail(err); }
  });

  ipcMain.handle('sync:peers', async () => {
    try { return await syncBundle.peers(); }
    catch (err) { return syncFail(err); }
  });

  ipcMain.handle('sync:pull-bundle', async (event, deviceId) => {
    try {
      const bundle = await syncBundle.pull(deviceId);
      pendingBundles.set(event.sender.id, bundle);
      return { ok: true, plan: portable.plan(bundle), source: 'remote' };
    } catch (err) {
      pendingBundles.delete(event.sender.id);
      return syncFail(err);
    }
  });

  // ---- Project files ----
  //
  // Push is the laptop's side; plan/pull is what the machine you come home to
  // does. Nothing deletes: a remote manifest missing a file is reported, never
  // acted on, because "bring me what is new" and "mirror this exactly" are
  // different requests and only one of them was made.
  ipcMain.handle('sync:files-list', async () => {
    try { return await syncFiles.list(); }
    catch (err) { return syncFail(err); }
  });

  ipcMain.handle('sync:files-push', async (event, { slug, root }) => {
    try { return await syncFiles.push(slug, root, syncConfig.fileOptions()); }
    catch (err) { return syncFail(err); }
  });

  ipcMain.handle('sync:files-plan', async (event, { slug, root }) => {
    try { return await syncFiles.plan(slug, root, syncConfig.fileOptions()); }
    catch (err) { return syncFail(err); }
  });

  ipcMain.handle('sync:files-pull', async (event, { slug, root }) => {
    try {
      const res = await syncFiles.pull(slug, root, syncConfig.fileOptions());
      // Anything written means this directory now holds code from elsewhere.
      // Mark it before returning, so a Run that follows is gated even if the
      // renderer never gets the reply.
      if (res.written > 0) res.trust = syncTrust.markReceived(root);
      return res;
    } catch (err) { return syncFail(err); }
  });

  // ---- Watching ----
  syncWatch.setNotifier((payload) => {
    if (!win.isDestroyed()) win.webContents.send('sync:event', payload);
  });
  app.on('will-quit', () => syncWatch.stopAll());

  ipcMain.handle('sync:watch-start', (event, { slug, root }) => {
    syncWatch.start(slug, root, syncConfig.fileOptions());
    return { ok: true, watching: syncWatch.watching() };
  });
  ipcMain.handle('sync:watch-stop', (event, slug) => {
    syncWatch.stop(slug);
    return { ok: true, watching: syncWatch.watching() };
  });
  ipcMain.handle('sync:watching', () => ({ ok: true, watching: syncWatch.watching() }));

  // ---- Receiving, on its own ----
  //
  // A pulled project lands in PROJECTS_DIR under its slug, which is where the
  // rail looks — so a project that appears on the server shows up as a tab
  // without anyone naming a path for it.
  const pullRoot = (slug) => path.join(PROJECTS_DIR, slug);

  function startPulling() {
    const slugs = syncConfig.all().pullProjects || [];
    return syncPull.start(slugs, pullRoot, (payload) => {
      if (!win.isDestroyed()) win.webContents.send('sync:event', payload);
    });
  }

  ipcMain.handle('sync:pull-start', () => startPulling());
  ipcMain.handle('sync:pull-stop', () => syncPull.stop());
  ipcMain.handle('sync:pull-state', () => syncPull.state());
  ipcMain.handle('sync:pull-now', async () => { await syncPull.sweep(); return syncPull.state(); });
  app.on('will-quit', () => syncPull.stop());

  // Pick up where the last session left off: the setting persists, the loop
  // and the live channel do not.
  if ((syncConfig.all().pullProjects || []).length) startPulling();

  // ---- The group key ----
  //
  // create() returns the recovery string, which is the only moment it exists
  // in a form a person can keep. It is passed straight to the renderer to show
  // and is not stored anywhere else.
  ipcMain.handle('sync:key-state', () => ({
    has: syncKeys.has(),
    available: syncKeys.available(),
    fingerprint: syncKeys.has() ? (() => { try { return syncKeys.fingerprint(); } catch (_) { return null; } })() : null,
  }));
  ipcMain.handle('sync:key-create', () => {
    try { return syncKeys.create(); }
    catch (err) { return { ok: false, code: err.code || 'other' }; }
  });
  ipcMain.handle('sync:key-recovery', () => {
    try { return { ok: true, recovery: syncKeys.recovery() }; }
    catch (err) { return { ok: false, code: err.code || 'other' }; }
  });
  ipcMain.handle('sync:key-adopt', (event, recoveryString) => {
    try { return syncKeys.adopt(syncKeys.fromRecovery(recoveryString)); }
    catch (err) { return { ok: false, code: err.code || 'other' }; }
  });

  // ---- Pairing ----
  //
  // The invite is a bearer secret with a short life. It is generated on
  // request and never stored: there is nothing to leak later because nothing
  // is kept.
  ipcMain.handle('sync:invite-create', (event, options) => {
    try { return syncInvite.create(options || {}); }
    catch (err) { return { ok: false, code: err.code || 'other', missing: err.missing }; }
  });
  ipcMain.handle('sync:invite-preview', (event, str) => {
    try { return syncInvite.preview(str); }
    catch (err) { return { ok: false, code: err.code || 'other', expiredAt: err.expiredAt }; }
  });
  ipcMain.handle('sync:invite-accept', (event, str) => {
    try { return syncInvite.accept(str, app.getPath('userData')); }
    catch (err) { return { ok: false, code: err.code || 'other' }; }
  });

  // ---- Remote format ----
  ipcMain.handle('sync:remote-state', async () => {
    try { return await syncFiles.remoteState(); }
    catch (err) { return syncFail(err); }
  });
  ipcMain.handle('sync:migrate', async () => {
    // The caller does not name paths: main knows where projects live, and the
    // set to re-upload is exactly the set this machine is configured to push.
    const roots = (syncConfig.all().pushProjects || [])
      .map((root) => ({ root, slug: path.basename(root) }));
    try { return await syncFiles.migrate(roots); }
    catch (err) { return syncFail(err); }
  });
  ipcMain.handle('sync:drop-legacy', async () => {
    try { return await syncFiles.dropLegacy(); }
    catch (err) { return syncFail(err); }
  });

  // ---- Trust ----
  ipcMain.handle('sync:trust-state', (event, projectPath) => syncTrust.stateOf(projectPath));
  ipcMain.handle('sync:trust-grant', (event, projectPath) => syncTrust.grant(projectPath));
  ipcMain.handle('sync:trust-revoke', (event, projectPath) => syncTrust.revoke(projectPath));

  // Whether the sync tab should offer itself at all.
  ipcMain.handle('sync:ready', () => {
    const missing = syncConfig.missingFields();
    const cfg = syncConfig.all();
    return { ok: missing.length === 0 && Boolean(cfg.hostKey), missing, pinned: Boolean(cfg.hostKey) };
  });

  // Re-diff the bundle that's already open — the plan goes stale the moment an
  // import writes anything.
  ipcMain.handle('portable:replan', (event) => {
    const bundle = pendingBundles.get(event.sender.id);
    if (!bundle) return { ok: false, error: 'no bundle open' };
    try { return { ok: true, plan: portable.plan(bundle) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('portable:apply', (event, options) => {
    const bundle = pendingBundles.get(event.sender.id);
    if (!bundle) return { ok: false, error: 'no bundle open' };
    let result;
    try { result = portable.apply(bundle, options || {}); }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
    if (!result.ok) return result;

    // An import can change theme, language and model choices out from under the
    // main window — re-push all three rather than leave it showing stale state.
    if (result.prefsChanged.includes('theme')) applyTheme(win);
    if (result.prefsChanged.includes('language')) applyLanguage(win);
    if (result.modelsWritten && !win.isDestroyed()) {
      win.webContents.send('portable:imported', { models: model.allFor() });
    }
    return result;
  });

  // ---- Settings ----
  ipcMain.handle('settings:open', () => { openSettingsWindow(win); return true; });
  ipcMain.on('settings:close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner && !owner.isDestroyed()) owner.close();
  });

  // ---- Sync: the remote, and proving we can reach it ----
  //
  // Nothing here moves a file yet. It configures where the sync will point and
  // establishes that the server on the other end is the one we think it is.
  ipcMain.handle('sync:config', () => syncConfig.forRenderer());
  ipcMain.handle('sync:save', (event, patch) => {
    try {
      return { ok: true, config: syncConfig.save(patch || {}) };
    } catch (err) {
      // The only failure that reaches here is a missing desktop keyring, which
      // is worth naming: safeStorage would otherwise "work" while encrypting
      // with a key anyone can derive.
      return { ok: false, code: String(err.message || err) };
    }
  });

  // Read the host key without sending a credential. The renderer shows the
  // fingerprint; only an explicit sync:pin makes it trusted.
  ipcMain.handle('sync:probe', async (event, patch) => {
    const cfg = { ...syncConfig.forConnect(), ...(patch || {}) };
    if (!cfg.host) return { ok: false, code: 'host' };
    try {
      const key = await syncTransport.probe(cfg);
      const known = syncConfig.all().hostKey;
      return {
        ok: true,
        hostKey: key,
        // Distinguishing these three in main keeps the renderer from having to
        // reason about trust at all: it renders what it is told.
        state: !known ? 'new' : (known.sha256 === key.sha256 ? 'known' : 'changed'),
        known: known || null,
      };
    } catch (err) {
      return { ok: false, code: err.code || 'other', detail: String(err.message || err) };
    }
  });

  ipcMain.handle('sync:pin', (event, hostKey) => syncConfig.pinHostKey(hostKey));

  ipcMain.handle('sync:test', async () => {
    const missing = syncConfig.missingFields();
    if (missing.length) return { ok: false, code: 'incomplete', missing };
    try {
      return await syncTransport.test(syncConfig.forConnect());
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'other',
        detail: String(err.message || err),
        expected: err.expected,
        got: err.got,
      };
    }
  });

  // The key file is chosen through main's dialog rather than typed: the
  // renderer never gets to name a path the main process will later read.
  ipcMain.handle('sync:pick-key', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(owner, {
      title: 'Private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  // ---- Updates ----
  ipcMain.handle('update:open', () => { openUpdateWindow(win); return true; });
  ipcMain.on('update:close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner && !owner.isDestroyed()) owner.close();
  });

  ipcMain.handle('update:state', () => (updateState ? { ok: true, state: updateState } : null));
  // `refresh` is only ever true for an explicit "check again": it runs
  // `apt-get update` under pkexec, and the background timer must not prompt.
  ipcMain.handle('update:check', (event, options) => checkForUpdate(win, options));

  ipcMain.handle('update:run', async (event) => {
    if (!updateState || !updateState.available) return { ok: false, error: 'nothing to install' };
    if (updateBusy) return { ok: false, error: 'an update is already running' };
    updateBusy = true;
    const sender = event.sender;
    const send = (payload) => { if (!sender.isDestroyed()) sender.send('update:progress', payload); };
    try {
      // apt does the fetching, the signature check and the install in one step,
      // so there is no download phase of our own to report progress for.
      send({ step: 'install' });
      const res = await updater.install();
      if (res.ok) {
        // The installed version moved; re-read it so the chip settles.
        await checkForUpdate(win);
        return { ok: true, version: updateState ? updateState.installed : null };
      }
      return { ok: false, ...res };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    } finally {
      updateBusy = false;
    }
  });

  // Fallback when the polkit prompt is unavailable or dismissed: hand the
  // command to a real TabDesk terminal and let the user type their password.
  ipcMain.handle('update:terminal', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('update:open-terminal', { command: updater.installCommand() });
      win.focus();
    }
    return { ok: true };
  });

  ipcMain.handle('update:restart', () => {
    app.relaunch();
    app.quit();
    return true;
  });

  // First check once the window has settled, then on a slow timer.
  const firstCheck = setTimeout(() => checkForUpdate(win), 8000);
  const recheck = setInterval(() => checkForUpdate(win), updater.CHECK_INTERVAL_MS);
  app.on('will-quit', () => { clearTimeout(firstCheck); clearInterval(recheck); });

  ipcMain.handle('usage:stats', () => scanUsage());

  // Plan limits (what /usage shows). Separate from usage:stats: that one is a
  // local scan of the transcripts, this one is the account's real quota.
  ipcMain.handle('usage:limits', () => usageLimits.getLimits());

  ipcMain.handle('system:stats', () => ({
    cpu: cpuPercent(),
    memUsed: os.totalmem() - os.freemem(),
    memTotal: os.totalmem(),
    uptime: os.uptime(),
  }));

  // Capture a region of the window (the focused terminal) to a PNG file.
  // An in-app xterm.js pane is DOM, so the window's own surface has it; a
  // native embedded pane needs the compositor (see captureEmbedRegion).
  ipcMain.handle('screenshot:capture', async (event, { rect, name, embed }) => {
    try {
      const image = embed
        ? await captureEmbedRegion(win, rect)
        : await win.webContents.capturePage({
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      if (!image || image.isEmpty()) return { ok: false, error: 'empty capture' };
      const pics = path.join(os.homedir(), 'Pictures');
      const dir = fs.existsSync(pics) ? pics : os.homedir();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safe = String(name || 'terminal').replace(/[^a-z0-9._-]/gi, '_');
      const file = path.join(dir, `tabdesk-${safe}-${stamp}.png`);
      fs.writeFileSync(file, image.toPNG());
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('preview:preload-url', () =>
    'file://' + path.join(__dirname, 'preview-preload.js'));

  // Launch a live preview for a project (static HTML or a running app) and
  // stream its lifecycle events back to the renderer.
  // The gate for both runners, in main rather than the renderer: a renderer
  // that forgets to ask is a renderer that bypasses it, and the check and the
  // question belong in the same process as the spawn they guard.
  //
  // Returns true to proceed. Approving is recorded, so the question is asked
  // once per delivery rather than once per press.
  async function allowRun(owner, projectPath, kind) {
    if (syncTrust.mayRun(projectPath)) return true;
    const strings = (activeI18n && activeI18n.strings) || {};
    const t = (k, fallback) => strings[k] || fallback;
    const isTerminal = kind === 'terminal';
    const { response } = await dialog.showMessageBox(owner, {
      type: 'warning',
      buttons: [
        isTerminal ? t('trust.open', 'Open it') : t('trust.run', 'Run it'),
        t('trust.cancel', 'Cancel'),
      ],
      defaultId: 1,
      cancelId: 1,
      title: 'TabDesk',
      message: t('trust.title', 'This project received files over sync'),
      detail: (isTerminal
        ? t('trust.detail.terminal',
          'Opening it starts your agent with this folder as its working directory, and the agent reads and acts on what it finds there. These files arrived from the sync server, not from you.\n\n{path}')
        : t('trust.detail',
          'Running it executes commands this folder defines — npm scripts, run.sh, or a Python interpreter inside it. Those arrived from the sync server, not from you.\n\n{path}')
      ).replace('{path}', projectPath),
      noLink: true,
    });
    if (response !== 0) return false;
    syncTrust.grant(projectPath);
    return true;
  }

  ipcMain.handle('preview:start', async (event, projectPath) => {
    // Both runners execute what the directory defines — npm scripts, run.sh,
    // and pythonBin()'s <project>/.venv/bin/python. That is fine for a folder
    // you wrote. For one that arrived over sync it is the server's code.
    if (!(await allowRun(BrowserWindow.fromWebContents(event.sender), projectPath))) {
      return { ok: false, code: 'declined' };
    }
    previewRunner.start(projectPath, (type, payload) => {
      if (!win.isDestroyed()) win.webContents.send('preview:event', { type, ...payload });
    });
    return true;
  });

  // Classify a project without running it. Deliberately not behind allowRun():
  // this executes nothing, and the renderer asks on every tab switch — a trust
  // prompt here would fire for merely looking at a tab.
  ipcMain.handle('preview:kind', (event, projectPath) => previewRunner.kindOf(projectPath));

  // Tear down the currently running preview process (if any).
  ipcMain.handle('preview:stop', () => { previewRunner.stop(); return true; });

  // ---- Run the project natively (its own window / dev server) ----
  ipcMain.handle('app:run', async (event, projectPath) => {
    if (!(await allowRun(BrowserWindow.fromWebContents(event.sender), projectPath))) {
      return { ok: false, code: 'declined' };
    }
    const plan = appRunner.start(projectPath, (type, payload) => {
      if (!win.isDestroyed()) win.webContents.send('app:event', { type, ...payload });
    });
    return plan ? { ok: true, label: plan.label } : { ok: false };
  });
  ipcMain.handle('app:stop', (event, projectPath) => appRunner.stop(projectPath));
  ipcMain.handle('app:running', (event, projectPath) => appRunner.isRunning(projectPath));

  // Hand a URL to the desktop's default browser. Only http(s)/file, so a
  // crafted preview URL can't reach a `mailto:`-style handler.
  ipcMain.handle('site:open-external', (event, url) => {
    const raw = String(url || '');
    if (/^https?:\/\//i.test(raw)) { shell.openExternal(raw); return true; }

    // file:// is here for one reason: a static preview has no server, so
    // handing it to the browser means handing it a path. Left as a bare scheme
    // check it is an execution primitive instead — xdg-open on a .desktop file
    // runs it, and the URL reaches this handler from the renderer. So the only
    // file:// that goes anywhere is an HTML file that actually exists.
    if (/^file:\/\//i.test(raw)) {
      let p;
      try { p = decodeURIComponent(new URL(raw).pathname); } catch (_) { return false; }
      if (!/\.html?$/i.test(p)) return false;
      try { if (!fs.statSync(p).isFile()) return false; } catch (_) { return false; }
      shell.openExternal(raw);
      return true;
    }
    return false;
  });

  // ---- Bugs & Feedback ------------------------------------------------------
  //
  // Same endpoint, header and payload shape Moraine posts to, so both apps land
  // in the one admin panel that already reads them. `app` is added here and
  // ignored by a server that does not know it yet — it is what lets the panel
  // tell a TabDesk report from a Moraine one once it grows a column for it,
  // since `version` alone cannot.
  //
  // The key is weak on purpose and always has been: it ships inside a public
  // binary, so it only turns away bots that hit the endpoint blind. It is not
  // an authenticator and nothing here should treat it as one.
  //
  // Posted from main rather than the renderer: this is the one request the app
  // makes to a host it does not serve, and keeping it here means no page ever
  // needs an origin exemption to reach it.
  ipcMain.handle('feedback:send', (event, payload) => new Promise((resolve) => {
    const body = JSON.stringify({
      type: ['bug', 'feedback', 'feature'].includes(payload && payload.type) ? payload.type : 'feedback',
      message: String((payload && payload.message) || '').slice(0, 8000),
      email: String((payload && payload.email) || '').slice(0, 200),
      version: app.getVersion(),
      os: process.platform,
      arch: process.arch,
      app: 'tabdesk',
    });

    const req = https.request({
      hostname: 'www.thern.io',
      path: '/feedback.php',
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Moraine-Key': 'mrn-fb-7d1a9c3e',
      },
    }, (res) => {
      // Drain: leaving the socket unread keeps the agent alive.
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300
        ? { ok: true }
        : { ok: false, code: `http-${res.statusCode}` });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, code: err.code || 'network' }));
    req.end(body);
  }));

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.on('term:create', async (event, { id, cols, rows, cwd, startCmd }) => {
    if (terminals.has(id)) return;
    // Same gate as the embedded backend — this path is only taken when native
    // embedding is off, and it starts the same agent in the same directory.
    if (cwd && !(await allowRun(BrowserWindow.fromWebContents(event.sender), cwd, 'terminal'))) {
      if (!win.isDestroyed()) win.webContents.send('term:declined', { id });
      return;
    }
    const shell = os.platform() === 'win32'
      ? 'powershell.exe'
      : (process.env.SHELL || '/bin/bash');

    const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: startDir,
      env: process.env,
    });

    // Optionally auto-run a command (e.g. launch Claude Code in the project).
    if (startCmd) {
      setTimeout(() => { try { term.write(startCmd + '\r'); } catch (_) {} }, 350);
    }

    term.onData((data) => {
      if (!win.isDestroyed()) win.webContents.send(`term:data:${id}`, data);
    });
    term.onExit(() => {
      terminals.delete(id);
      if (!win.isDestroyed()) win.webContents.send(`term:exit:${id}`);
    });

    terminals.set(id, term);
  });

  ipcMain.on('term:input', (event, { id, data }) => {
    const term = terminals.get(id);
    if (term) term.write(data);
  });

  ipcMain.on('term:resize', (event, { id, cols, rows }) => {
    const term = terminals.get(id);
    if (term && cols > 0 && rows > 0) {
      try { term.resize(cols, rows); } catch (_) { /* ignore transient resize errors */ }
    }
  });

  ipcMain.on('term:kill', (event, { id }) => {
    const term = terminals.get(id);
    if (term) {
      term.kill();
      terminals.delete(id);
    }
  });

  ipcMain.on('window:toggle-fullscreen', () => {
    win.setFullScreen(!win.isFullScreen());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const term of terminals.values()) term.kill();
  terminals.clear();
  termEmbed.killAll();
  previewRunner.stop();
  appRunner.stopAll();
  if (process.platform !== 'darwin') app.quit();
});
