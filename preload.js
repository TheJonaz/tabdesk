const { contextBridge, ipcRenderer, webUtils } = require('electron');
// NOTE: this preload runs sandboxed — only 'electron' is requireable here.
// Anything needing Node core modules (path, fs, …) must live in the main process.

// Theme + strings are fetched synchronously: the renderer applies them before
// its first paint, so the UI never flashes in the wrong colours or language.
let boot = { theme: null, i18n: null, settings: {} };
try { boot = ipcRenderer.sendSync('app:boot') || boot; } catch (_) { /* main not ready */ }

contextBridge.exposeInMainWorld('api', {
  boot,

  // ---- Theme / language (backing for the future theme manager) ----
  listThemes: () => ipcRenderer.invoke('theme:list'),
  setTheme: (id) => ipcRenderer.invoke('theme:set', id),
  onThemeChanged: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.removeListener('theme:changed', listener);
  },
  listLanguages: () => ipcRenderer.invoke('i18n:list'),
  setLanguage: (code) => ipcRenderer.invoke('language:set', code),
  onLanguageChanged: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('i18n:changed', listener);
    return () => ipcRenderer.removeListener('i18n:changed', listener);
  },

  // ---- Claude model, chosen per project ----
  listModels: () => ipcRenderer.invoke('model:list'),
  getGlobalModel: () => ipcRenderer.invoke('model:global'),
  getModel: (projectPath) => ipcRenderer.invoke('model:get', projectPath),
  setModel: (projectPath, id) => ipcRenderer.invoke('model:set', { path: projectPath, id }),

  // Which CLI a project's terminal starts. listAgents() returns only what is
  // actually installed, each with the command line it starts — those strings
  // are main's own constants, never anything the user typed.
  listAgents: () => ipcRenderer.invoke('agents:list'),
  getAgent: (projectPath) => ipcRenderer.invoke('agents:get', projectPath),
  setAgent: (projectPath, id) => ipcRenderer.invoke('agents:set', { path: projectPath, id }),
  onGlobalModelChanged: (cb) => {
    const listener = (_event, id) => cb(id);
    ipcRenderer.on('model:global-changed', listener);
    return () => ipcRenderer.removeListener('model:global-changed', listener);
  },

  getPreviewPreloadUrl: () => ipcRenderer.invoke('preview:preload-url'),
  startPreview: (cwd) => ipcRenderer.invoke('preview:start', cwd),
  stopPreview: () => ipcRenderer.invoke('preview:stop'),
  previewKind: (cwd) => ipcRenderer.invoke('preview:kind', cwd),
  onPreviewEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('preview:event', listener);
    return () => ipcRenderer.removeListener('preview:event', listener);
  },

  // Run the project natively (own window / dev server), separate from preview.
  runApp: (cwd) => ipcRenderer.invoke('app:run', cwd),
  stopApp: (cwd) => ipcRenderer.invoke('app:stop', cwd),
  isAppRunning: (cwd) => ipcRenderer.invoke('app:running', cwd),
  onAppEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('site:open-external', url),
  sendFeedback: (payload) => ipcRenderer.invoke('feedback:send', payload),
  appVersion: () => ipcRenderer.invoke('app:version'),

  // Export / import of the portable light layer (memory, CLAUDE.md, prefs).
  // Opening that window is Settings' job now; the rail only listens for what
  // an import changed, so it can repaint the tabs it touched.
  onPortableImported: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('portable:imported', listener);
    return () => ipcRenderer.removeListener('portable:imported', listener);
  },

  // Settings: theme and language today, sync configuration next.
  openSettings: () => ipcRenderer.invoke('settings:open'),

  // Updates: a background check raises the chip in the system bar; the window
  // does the rest.
  openUpdate: () => ipcRenderer.invoke('update:open'),
  onUpdateAvailable: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('update:available', listener);
    return () => ipcRenderer.removeListener('update:available', listener);
  },
  // The update window asks for the install command to be run in a real tab.
  onUpdateTerminal: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('update:open-terminal', listener);
    return () => ipcRenderer.removeListener('update:open-terminal', listener);
  },

  listProjects: () => ipcRenderer.invoke('projects:list'),
  // Remembers a closed tab across restarts (and an opened one as no longer closed).
  setProjectClosed: (dir, closed) => ipcRenderer.send('projects:closed', { path: dir, closed }),
  // Remembers the rail's order (project paths, top first) for the next start.
  setProjectOrder: (paths) => ipcRenderer.send('projects:order', { paths }),
  // Opens the "new tab" picker window; resolves with the choice, or null.
  pickProject: () => ipcRenderer.invoke('projects:pick'),
  getUsageStats: () => ipcRenderer.invoke('usage:stats'),
  getUsageLimits: () => ipcRenderer.invoke('usage:limits'),
  getSystemStats: () => ipcRenderer.invoke('system:stats'),
  // `embed` picks the capture path in main: a native terminal window isn't part
  // of the app's own surface, so it has to be cut out of the screen instead.
  captureTerminal: (rect, name, embed) =>
    ipcRenderer.invoke('screenshot:capture', { rect, name, embed }),
  createTerminal: (id, cols, rows, cwd, startCmd) => ipcRenderer.send('term:create', { id, cols, rows, cwd, startCmd }),

  // Embedded native terminal (xterm as a real X11 window reparented into a panel).
  createEmbedTerminal: (id, cwd, startCmd) => ipcRenderer.send('embed:create', { id, cwd, startCmd }),
  // Main refused to start a terminal for an untrusted synced project. The tab
  // has to be put back to unmaterialized, or its panel stays empty and the
  // only way to retry is closing and reopening it.
  onTerminalDeclined: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('term:declined', listener);
    return () => ipcRenderer.removeListener('term:declined', listener);
  },
  placeEmbedTerminal: (id, rect) => ipcRenderer.send('embed:place', { id, rect }),
  hideEmbedTerminal: (id) => ipcRenderer.send('embed:hide', { id }),
  // Hands the keyboard to the terminal window itself — see term-embed focus().
  focusEmbedTerminal: (id) => ipcRenderer.send('embed:focus', { id }),
  // The on-disk path behind a dropped File. `File.path` still answers on
  // Electron 31, but it is gone in 32 and webUtils is the replacement, so ask
  // webUtils first and keep the old property only as a fallback.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch (_) { return file.path || ''; }
  },
  // Types text into the native terminal window. Resolves false when it could
  // not be delivered, so a drop that goes nowhere can say so.
  insertIntoEmbed: (id, text) => ipcRenderer.invoke('embed:insert', { id, text }),
  killEmbedTerminal: (id) => ipcRenderer.send('embed:kill', { id }),
  onEmbedReady: (cb) => {
    const listener = (_event, { id }) => cb(id);
    ipcRenderer.on('embed:ready', listener);
    return () => ipcRenderer.removeListener('embed:ready', listener);
  },
  // The embedded terminal wrote something — the stand-in for the pty data
  // stream the xterm.js backend gets.
  onEmbedActivity: (cb) => {
    const listener = (_event, { id }) => cb(id);
    ipcRenderer.on('embed:activity', listener);
    return () => ipcRenderer.removeListener('embed:activity', listener);
  },

  sendInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  killTerminal: (id) => ipcRenderer.send('term:kill', { id }),
  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),

  onData: (id, cb) => {
    const channel = `term:data:${id}`;
    const listener = (_event, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onExit: (id, cb) => {
    const channel = `term:exit:${id}`;
    const listener = () => cb();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // ---- System tray ----
  // Push a snapshot of the rail so the tray menu can mirror it. Sent on every
  // tab add / close / rename / switch; the tray keeps no state of its own.
  syncTray: (payload) => ipcRenderer.send('tray:tabs', payload),
  onTraySelect: (cb) => {
    const listener = (_event, id) => cb(id);
    ipcRenderer.on('tray:select', listener);
    return () => ipcRenderer.removeListener('tray:select', listener);
  },
});
