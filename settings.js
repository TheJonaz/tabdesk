// Persisted user preferences (userData/settings.json).
//
// Theme and language default to 'system': the app follows the desktop until the
// user explicitly pins one. projectModels maps a project path to the Claude
// model that project runs with; a project with no entry follows Claude Code's
// own default. closedProjects lists the project paths whose tab was closed with
// the ×, so the rail doesn't rebuild them from the directories on disk.
// projectOrder is the rail read top to bottom as the last session left it, so
// the tabs come back where you put them instead of in directory-mtime order.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  theme: 'system', language: 'system', projectModels: {}, closedProjects: [], projectOrder: [],
};

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function all() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch (_) {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get(key) { return all()[key]; }

function set(key, value) {
  const next = { ...all(), [key]: value };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('[settings] could not persist', String(err));
  }
  return next;
}

module.exports = { all, get, set, DEFAULTS };
