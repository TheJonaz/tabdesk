// Embed real native terminal windows inside the app's panels (X11 only).
//
// We launch xterm with its `-into <xid>` flag: xterm reparents itself into the
// given X window at startup and — crucially — relayouts and repaints correctly
// when we move/resize it with xdotool. GTK3 terminals (xfce4-terminal, gnome-
// terminal) do NOT: after an external windowsize they keep painting only their
// original allocation, leaving the rest of the panel transparent/garbled. That
// (plus xfce4-terminal 1.1.3 dropping GtkSocket/XEMBED) is why we use xterm.
//
// Each panel gets its own xterm process with a real PTY. We freeze the window
// title so we can find the X window, then position it to match the panel's
// on-screen rectangle pushed from the renderer.
//
// Caveats (inherent to native embedding, not bugs):
//   * The terminal is a native X window stacked ABOVE the Chromium content,
//     so it covers whatever DOM sits in that rectangle — and that stacking has
//     to be re-asserted, because Chromium takes it back on a window resize
//     (see raise()).
//   * Electron's in-app capturePage() cannot see it, so screenshots of a native
//     pane go via the screen instead (captureEmbedRegion in main.js).
//   * It must be repositioned whenever the panel moves or resizes.

const { spawn, execFile } = require('child_process');
const fs = require('fs');

let parentXid = null;
// id -> { id, proc, win, applied, pending, busy, mapped, hidden, ready, dead,
//         wchar, wantFocus }
const embeds = new Map();

// Colours for newly spawned terminals, pushed from the active theme. xterm
// reads them only at launch, so a theme switch reaches existing panes on their
// next open, not live.
let colors = { background: '#03060f', foreground: '#eaf4ff', cursor: '#34e2ff' };
function setTheme(term) {
  if (term) colors = { ...colors, ...term };
}

// xterm's -bg/-fg/-cr only take opaque colours; tokens may carry alpha.
function solid(c, fallback) {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(c || '').trim());
  return m ? m[0] : fallback;
}

// Told when a terminal is first on screen, so the renderer can drop the "▶
// terminal…" placeholder it draws underneath.
let notifyReady = null;
function setReadyNotifier(fn) { notifyReady = fn; }

// ---- Activity ---------------------------------------------------------------
//
// The rail marks a background tab busy while its command runs and green once it
// falls quiet. In the xterm.js backend that falls out of the pty data stream,
// but here xterm owns the pty and we never see a byte of it.
//
// What we can see is how much xterm itself has written: /proc/<pid>/io's wchar
// counts bytes out, and it moves whenever the terminal writes — which it does
// as output arrives, INCLUDING while its window is unmapped. That last part is
// what makes it usable, because the unmapped case is precisely the background
// tab we want to flag. We only ever compare the counter to its previous value;
// the bytes themselves are never read.
let notifyActivity = null;
function setActivityNotifier(fn) { notifyActivity = fn; }

const ACTIVITY_POLL_MS = 500;

// An idle terminal is not a silent one. xterm keeps writing to its X connection
// for repaints and cursor blink, and the counter sees that traffic just as it
// sees command output. Measured on a genuinely untouched pane: ~80 bytes per
// 12 s, a few bytes per poll — while a pane actually producing output runs to
// thousands of bytes per poll. Reporting any byte at all as activity is what
// painted tabs green that nobody had worked in.
const ACTIVITY_MIN_BYTES = 512;

// One poll over that floor is still not a command running.
//
// Measured across four minutes of live panes: a session sitting idle emits a
// lone redraw now and then — 539 bytes on one, 3465 on another, 640 on a third,
// each a single poll with silence either side. A session actually working held
// the counter up for 300-400 consecutive polls. The catch is that both write
// the same amount per poll: 388 of one working pane's 395 polls were between
// 512 bytes and 4 kB, squarely on top of the redraw range. Magnitude cannot
// separate them, so raising the floor would only buy quiet by going deaf.
// Persistence separates them cleanly, because a redraw has nothing to follow it.
//
// A lone poll far above anything a redraw produces is still real — 60 kB
// arriving at once is a command that printed and finished — so it counts on its
// own rather than waiting for a second that never comes.
const ACTIVITY_RUN_MS = 2000;
const ACTIVITY_BURST_BYTES = 16384;

// Starting up is not activity either: xterm writes tens of kB before the first
// prompt and the command draws its own banner on top of that. Without a grace
// period a tab you open and immediately switch away from goes "done" a few
// seconds later, having done nothing but start.
const ACTIVITY_GRACE_MS = 8000;

let activityTimer = null;

function wcharOf(pid) {
  try {
    const m = /wchar:\s*(\d+)/.exec(fs.readFileSync(`/proc/${pid}/io`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch (_) {
    return null;      // exited, or no procfs (non-Linux)
  }
}

function pollActivity() {
  const at = Date.now();
  for (const [id, rec] of embeds) {
    if (rec.dead || !rec.proc) continue;
    const w = wcharOf(rec.proc.pid);
    if (w === null) continue;
    const prev = rec.wchar;
    rec.wchar = w;
    // Only a hidden terminal can raise a flag worth raising, and only a hidden
    // terminal has a counter worth trusting. A mapped xterm spends tens of
    // kilobytes on ordinary repainting — far above the threshold below — so
    // bytes measured while it was visible say nothing about whether the command
    // running in it did anything.
    //
    // hide() re-baselines for exactly that reason, but it lands a frame or more
    // after the renderer has already stopped counting the tab as watched:
    // setActive() updates `visible` synchronously and defers the sync through
    // requestAnimationFrame, which Chromium throttles hard whenever the window
    // is occluded. Anything polled inside that gap gets charged to a tab the
    // renderer will now flag instead of clear — the tab going green on the way
    // out, which d0ef237 narrowed but could not close from the hide() side.
    //
    // The assignment above still runs, so the baseline keeps tracking while the
    // terminal is visible; only the reporting is suppressed. That leaves the
    // first hidden poll comparing against a fresh number either way.
    if (!rec.hidden) continue;
    if (prev === null) continue;                              // baseline, not activity
    if (at - rec.startedAt < ACTIVITY_GRACE_MS) continue;     // still starting up
    if (w - prev < ACTIVITY_MIN_BYTES) continue;              // idle repaint trickle
    // Qualifying twice inside ACTIVITY_RUN_MS is what makes it a command rather
    // than a redraw; a big enough single poll speaks for itself. Recording the
    // moment before the test is what lets the second poll of a real run pass —
    // and what lets a lone one time out before the next redraw arrives.
    const sustained = rec.qualAt !== null && rec.qualAt !== undefined
      && at - rec.qualAt <= ACTIVITY_RUN_MS;
    rec.qualAt = at;
    if (!sustained && w - prev < ACTIVITY_BURST_BYTES) continue;
    if (notifyActivity) notifyActivity(id);
  }
}

function startActivityPolling() {
  if (activityTimer) return;
  activityTimer = setInterval(pollActivity, ACTIVITY_POLL_MS);
  // A stat poll must not be the reason the process stays alive at quit.
  if (activityTimer.unref) activityTimer.unref();
}

function stopActivityPolling() {
  if (!activityTimer) return;
  clearInterval(activityTimer);
  activityTimer = null;
}

// Grab the Electron window's X11 window id (little-endian XID on Linux).
function init(win) {
  try {
    parentXid = win.getNativeWindowHandle().readUInt32LE(0);
  } catch (_) {
    parentXid = null;
  }
}

function xdo(args) {
  return new Promise((resolve) => {
    execFile('xdotool', args, { timeout: 4000 }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim()));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Asking X what actually happened ----------------------------------------
//
// Every placement here is fire-and-forget: we run an xdotool chain and then
// write down what we asked for as if it had happened. It usually has — but when
// it hasn't, the note is what makes the failure permanent, because drain() skips
// a rect it believes is already applied and hide() never revisits a window it
// believes is down. Both leave the same thing on screen: an xterm at its default
// 80x24 in the corner of the Electron window, over the rail, above the page,
// for the rest of the session. So the two moments that can diverge — the first
// placement and every unmap — are checked against X instead of assumed.

// `xdotool search` matches on name alone and returns windows that are not on
// screen (every hidden pane still answers to its title), so "is it actually
// up?" is a --onlyvisible search, not a plain one.
async function onScreen(rec) {
  const out = await xdo(['search', '--onlyvisible', '--name', `^${rec.title}$`]);
  return !!out && out.split('\n').some((l) => l.trim() === rec.win);
}

// xterm rounds its window to whole character cells, so an exact match is the
// wrong test; this only has to tell a placed pane from an unplaced one.
const SIZE_SLACK = 32;
async function sized(rec, rect) {
  const out = await xdo(['getwindowgeometry', '--shell', rec.win]);
  const w = /WIDTH=(\d+)/.exec(out || '');
  const h = /HEIGHT=(\d+)/.exec(out || '');
  if (!w || !h) return true;   // no answer: believe the move rather than loop on it
  return Math.abs(Number(w[1]) - rect.w) <= SIZE_SLACK &&
         Math.abs(Number(h[1]) - rect.h) <= SIZE_SLACK;
}

// Take the window down and make sure it stays down.
//
// `-into` reparents AND maps, with no flag to hold that back, so hiding a pane
// that is still starting is a race rather than a command: an unmap that lands
// before xterm's own map is a no-op on an already-unmapped window, xterm maps a
// moment later, and the pane we think is hidden is on screen at its default
// geometry with nothing left to move or hide it. Re-check for a couple of
// seconds after launch — and once always, because a failed xdotool call reads
// exactly like a successful one from here.
const STARTUP_RACE_MS = 10000;
const UNMAP_RECHECKS = [120, 250, 500, 1000];

async function unmap(rec) {
  await xdo(['windowunmap', rec.win]);
  for (const delay of UNMAP_RECHECKS) {
    await wait(delay);
    if (rec.dead || !rec.hidden) return;      // a show landed; drain() maps it
    if (await onScreen(rec)) { await xdo(['windowunmap', rec.win]); continue; }
    if (Date.now() - rec.startedAt > STARTUP_RACE_MS) return;  // down, and past the race
  }
}

// Poll for the window carrying our unique title until it maps (or we give up).
//
// The pattern is ANCHORED, and that is not a detail: `xdotool search --name`
// takes a regular expression and matches it unanchored, so a bare `tabdesk-99-t4`
// also matches `tabdesk-99-t43` — every tab id that is a prefix of another one
// collides, and t1/t11, t2/t23 and t4/t43 all turn up in an ordinary session.
// The loser takes whichever window X happens to list first, so two panes end up
// driving the SAME terminal: one tab shows the other's session, and the window
// nobody claimed is left parked wherever it started.
async function findWindow(title, rec, tries = 50) {
  // The title is built from our pid and a tab id, so there is nothing in it to
  // escape — but it is worth knowing that this is why.
  const pattern = `^${title}$`;
  for (let i = 0; i < tries && !rec.dead; i++) {
    const out = await xdo(['search', '--name', pattern]);
    if (out) {
      const id = out.split('\n')[0].trim();
      if (id) return id;
    }
    await wait(100);
  }
  return null;
}

async function create(id, { cwd, startCmd }) {
  if (embeds.has(id)) return;
  if (!parentXid) { console.warn('[term-embed] no parent XID (not X11?); cannot embed'); return; }

  // Tab ids restart at t1 every launch, so a bare `tabdesk-t1` is not unique on
  // the display: an xterm orphaned by an earlier run (the app exiting without
  // reaping its terminals) still answers to that name, and findWindow would
  // hand back the ghost — the app then moves and resizes a dead window while
  // the real terminal sits unplaced in the corner at its default geometry.
  // Stamping our own pid makes the name unique to this run.
  const title = `tabdesk-${process.pid}-${id}`;
  const shell = process.env.SHELL || '/bin/bash';
  // Run the project command, then drop into an interactive shell so the pane
  // stays usable after (e.g.) Claude Code exits.
  const inner = startCmd ? `${startCmd}; exec ${shell} -i` : `exec ${shell} -i`;

  const args = [
    '-into', String(parentXid),   // reparent into the Electron window at launch
    '-T', title,                  // set the initial title so we can find it…
    '-xrm', 'XTerm*allowTitleOps: false', // …and freeze it (apps can't rename)
    '-b', '0', '-bw', '0',        // no inner padding, no window border
    '+sb',                        // no scrollbar
    '-bg', solid(colors.background, '#03060f'),
    '-fg', solid(colors.foreground, '#eaf4ff'),
    '-cr', solid(colors.cursor, '#34e2ff'),
    '-fa', 'DejaVu Sans Mono', '-fs', '11',
    '-e', shell, '-lc', inner,
  ];

  const rec = { id, title, proc: null, win: null, applied: null, pending: null, busy: false,
                mapped: false, hidden: false, ready: false, dead: false, wchar: null,
                settle: null, wantFocus: false, startedAt: Date.now(),
                fails: 0, verified: false };
  embeds.set(id, rec);
  startActivityPolling();

  rec.proc = spawn('xterm', args, {
    detached: true,               // own process group -> killable as a unit
    stdio: 'ignore',
    cwd: cwd || undefined,        // the shell inherits the terminal's cwd
  });
  rec.proc.on('exit', () => { rec.dead = true; });

  const win = await findWindow(title, rec);
  if (!win || rec.dead || !embeds.has(id)) return;
  rec.win = win;

  // xterm has already mapped this window itself: `-into` reparents AND maps at
  // startup, and there is no flag to hold that back. Not asking for the map is
  // therefore not enough — the map that has to be undone is xterm's.
  //
  // For a pane the renderer is showing this costs nothing: our first placement
  // lands a frame or two later and moves it into the panel. For a pane it is
  // NOT showing, nothing ever overwrites it, and the terminal sits at its
  // default 80x24 in the corner of the Electron window — over the tab bar, the
  // rail and whatever pane is open — for the rest of the session. That is the
  // box that "pops up in the middle": a pane whose xterm finished starting
  // after the renderer had already put it away.
  //
  // From here on, mapping is something only apply() does, and it always has a
  // rect to map to.
  rec.mapped = true;                      // xterm's doing, not ours
  if (rec.hidden || !rec.pending) {
    rec.mapped = false;
    rec.applied = null;
    await unmap(rec);                     // and see that it stays unmapped
  }
  await drain(rec);
}

// Move + resize in ONE xdotool invocation: two processes per frame would race
// each other, and a resize drag pushes a new rect every frame. Without --sync
// (we serialise ourselves in drain(), so we don't need X round-trips) the call
// stays cheap enough to keep up with the drag.
const APPLY_RETRIES = 3;
const APPLY_RETRY_MS = 200;

async function apply(rec, rect) {
  const args = ['windowmove', rec.win, String(rect.x), String(rect.y),
                'windowsize', rec.win, String(rect.w), String(rect.h)];
  if (!rec.mapped) args.push('windowmap', rec.win);
  args.push('windowraise', rec.win);   // see raise()
  // xdotool runs a chain and stops at the first command that fails, so a failed
  // call tells us nothing about how much of it landed. Writing the rect down
  // anyway is what turns one hiccup into a ghost: the next sync sees its own
  // rect in rec.applied, takes the "nothing to move" path, raises — and keeps
  // raising an unplaced terminal for the rest of the session.
  if ((await xdo(args)) === null) {
    rec.applied = null;
    if (rec.fails++ < APPLY_RETRIES) {
      if (!rec.pending) rec.pending = rect;   // a newer rect wins over this one
      await wait(APPLY_RETRY_MS);
    }
    return;
  }
  rec.fails = 0;
  rec.mapped = true;
  rec.applied = rect;
  // The first placement is the one that can lose to xterm's own startup: it
  // maps and sizes the window when it realises it, over whatever we set first —
  // and since we skip windowmap for a window xterm has already mapped, a map
  // that hadn't happened yet leaves the pane placed but invisible. Confirm both,
  // once, so a pane that reads back odd can't loop here.
  if (!rec.verified) {
    rec.verified = true;
    if (!(await onScreen(rec)) || !(await sized(rec, rect))) {
      rec.applied = null;
      rec.mapped = false;      // make the retry map it explicitly
      rec.pending = rect;
      return;
    }
  }
  // First time on screen — the renderer can drop its placeholder now.
  if (!rec.ready) { rec.ready = true; if (notifyReady) notifyReady(rec.id); }
  // A focus asked for before the window existed (opening a tab starts xterm and
  // selects it in the same breath) lands here, once there is something to focus.
  // Not awaited: focus() retries for up to a second, and drain() is still on the
  // hook for the next resize frame.
  if (rec.wantFocus) { rec.wantFocus = false; focus(rec.id); }
}

// Put the keyboard in this terminal.
//
// X11 keyboard focus sits on the Electron window, and nothing moves it to a
// child window on its own: selecting a tab used to show you a terminal that
// ignored everything you typed until you clicked inside it. The click did the
// focusing, not the selection — so selection has to do it too.
//
// A tab opened for the first time asks for this while its xterm is still
// starting, so an unready window records the wish and apply() honours it.
//
// One XSetInputFocus does not hold. What gets us here is a click in the page,
// and Chromium claims the keyboard for its own render widget as it finishes
// handling that click — landing after our call as often as before it, which
// undoes it with nothing to show for it. A window that was mapped this frame
// can also refuse focus outright. So the focus is asked for, read back from X,
// and asked for again until it sticks: the tab you clicked is the one you can
// type in, without clicking a second time inside the terminal.
const FOCUS_TRIES = [0, 60, 150, 350, 700];

// Only the newest request retries. Clicking through three tabs must not leave
// two loops fighting the third one for the keyboard.
let focusSeq = 0;

// `getwindowfocus` on its own walks up from the focused window to the nearest
// one the window manager knows about — and an xterm reparented into the app is
// not one, so it answers "the Electron window" for every terminal alike. `-f`
// is the question actually being asked here: which window has the input focus.
async function focusStuck(rec) {
  const out = await xdo(['getwindowfocus', '-f']);
  return out !== null && out === rec.win;
}

async function focus(id) {
  const rec = embeds.get(id);
  if (!rec || rec.dead) return;
  if (!rec.win || !rec.mapped || rec.hidden) { rec.wantFocus = true; return; }
  const seq = ++focusSeq;
  for (const delay of FOCUS_TRIES) {
    if (delay) await wait(delay);
    // A newer pick, a hide, or a closed tab: this one is no longer the answer.
    if (rec.dead || rec.hidden || seq !== focusSeq) return;
    await xdo(['windowfocus', rec.win]);
    if (await focusStuck(rec)) return;
  }
}

// Type text into a terminal — what a file drop turns into.
//
// It has to go in as keystrokes, because the pty belongs to xterm, not to us:
// nothing here holds the write end. Two ways to send them, and only one is
// usable. `xdotool type --window` sends XSendEvent, which xterm ignores unless
// it was launched with allowSendEvents — and turning that on would let any X
// client on the display type into your terminals, for a feature that does not
// need it. So this uses XTEST instead: focus the window, then type into
// whatever holds the focus.
//
// That makes the focus load-bearing rather than cosmetic. XTEST goes to the
// focused window whatever it is, so typing without checking would mean pasting
// a path into the wrong terminal — or into the page. focus() already retries
// until it sticks; this re-reads the focus afterwards and gives up rather than
// typing blind.
async function insert(id, text) {
  const rec = embeds.get(id);
  if (!rec || rec.dead || !rec.win || !rec.mapped || rec.hidden) return false;
  if (!text) return false;

  await focus(id);
  if (rec.dead || rec.hidden || !(await focusStuck(rec))) return false;

  // --clearmodifiers: a drop ends with the mouse button up but can leave a
  // modifier held (dragging with Ctrl to copy), which would otherwise turn the
  // typed path into control characters.
  //
  // The delay is not politeness, it is correctness. At `--delay 0` a dropped
  // path arrives scrambled — xdotool has to remap keysyms it cannot find on the
  // current layout, and firing the whole string at once races that remapping,
  // so characters land transposed. 12ms is xdotool's own default and types a
  // long path in well under a second.
  const out = await xdo(['type', '--clearmodifiers', '--delay', '12', '--', text]);
  return out !== null;
}

// Chromium's rendering surface is itself a child X window covering the whole
// client area, and dragging the main window's edge restacks it ABOVE our
// terminals. They stay mapped, correctly sized and correctly placed — they just
// end up underneath, which on screen is indistinguishable from having vanished,
// in every tab at once, for the rest of the session. Nothing puts them back:
// the geometry never changed, so the renderer's next sync is a no-op.
//
// So every placement ends with a raise, a placement that would otherwise be
// skipped raises anyway, and a burst of them raises once more after it settles —
// a restack that lands just after the drag's final move would otherwise stand.
// A programmatic resize does not trigger it, which is why this survived testing.
async function raise(rec) {
  if (rec.win && !rec.dead && rec.mapped) await xdo(['windowraise', rec.win]);
}

const SETTLE_MS = 250;
function raiseWhenSettled(rec) {
  if (rec.settle) clearTimeout(rec.settle);
  rec.settle = setTimeout(() => {
    rec.settle = null;
    if (!rec.hidden) raise(rec);
  }, SETTLE_MS);
  // A pending raise must not be the reason the process stays alive at quit.
  if (rec.settle.unref) rec.settle.unref();
}

// Serialise placement per embed and keep only the newest rect: overlapping
// xdotool processes finish out of order, so a stale rect could win the race and
// strand the terminal off-panel (which looks like it vanished — you see the DOM
// placeholder underneath instead).
// Hiding goes through here too: an unmap racing a move would otherwise settle
// with the window off screen but rec.mapped still true, so the next show would
// move a window it never maps again — a pane that comes back blank.
async function drain(rec) {
  if (rec.busy) return;
  rec.busy = true;
  try {
    while (rec.win && !rec.dead) {
      if (rec.hidden) {
        if (!rec.mapped) break;
        rec.mapped = false;
        rec.applied = null;   // force a full move+size on the next show
        await unmap(rec);
        continue;             // a show may have landed during the round trip
      }
      if (!rec.pending) break;
      const rect = rec.pending;
      rec.pending = null;
      const a = rec.applied;
      if (a && a.x === rect.x && a.y === rect.y && a.w === rect.w && a.h === rect.h && rec.mapped) {
        // Nothing to move, but this is the only moment a buried terminal gets
        // noticed at all — a tab switch or any later sync brings it back up.
        await raise(rec);
        continue;
      }
      await apply(rec, rect);
    }
    if (!rec.hidden && rec.mapped) raiseWhenSettled(rec);
  } finally {
    rec.busy = false;
  }
}

function place(id, rect) {
  const rec = embeds.get(id);
  if (!rec) return;
  rec.hidden = false;
  const norm = {
    x: Math.round(rect.x), y: Math.round(rect.y),
    w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)),
  };
  // latest-wins: drain() collapses a burst of resize frames into one move.
  rec.pending = norm;
  if (rec.win) drain(rec);
}

async function hide(id) {
  const rec = embeds.get(id);
  if (!rec) return;
  // Record the request even when the X window hasn't appeared yet. A pane can
  // be hidden within the second xterm needs to start (grid trimming, a quick
  // tab switch, session restore materialising tabs behind the visible one) and
  // dropping that hide used to leave create() with a queued rect — or nothing
  // at all — for a pane the renderer had already put away.
  rec.pending = null;
  rec.hidden = true;
  // Drop the byte baseline. The counter is the xterm's total writes, and a
  // visible terminal spends tens of kilobytes on ordinary repainting — while
  // a hidden one, being unmapped, spends none. Keeping the baseline across the
  // transition means the next poll reports everything drawn during the visible
  // period as activity on a tab that is no longer being watched, which is the
  // exact condition for "busy, then done": the tab turns green and hoists
  // itself the moment you look away from it. Re-baselining makes the first
  // poll after a hide establish a new zero and report nothing, which is what
  // the `prev === null` branch in pollActivity is already there for.
  rec.wchar = null;
  // Same for the run: whatever qualified while you were watching must not be
  // the first half of a pair completed by the first redraw after you left.
  rec.qualAt = null;
  // drain() does the unmap, and only when the window is actually mapped: the
  // renderer re-hides every hidden panel on each sync, so a resize drag would
  // otherwise spawn an xdotool unmap per frame per hidden tab.
  if (rec.win) await drain(rec);
}

function kill(id) {
  const rec = embeds.get(id);
  if (!rec) return;
  embeds.delete(id);
  if (rec.settle) { clearTimeout(rec.settle); rec.settle = null; }
  if (rec.proc && !rec.proc.killed) {
    try { process.kill(-rec.proc.pid, 'SIGTERM'); }
    catch (_) { try { rec.proc.kill(); } catch (_) { /* gone */ } }
  }
}

function killAll() {
  for (const id of [...embeds.keys()]) kill(id);
  stopActivityPolling();
}

module.exports = {
  init, create, place, hide, focus, insert, kill, killAll,
  setTheme, setReadyNotifier, setActivityNotifier,
};
