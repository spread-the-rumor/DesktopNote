/**
 * Local settings store. Persists the user's API keys/config to a single JSON
 * file in Electron's userData dir — no database, no cloud — alongside
 * meetings.json. This is what replaces the dev-only .env for packaged builds:
 * the app ships with no keys, the user enters their own in the Settings view,
 * and they're saved here.
 *
 * Mirrors store.js exactly: a module-level filePath set by init(), forgiving
 * reads (missing/corrupt file → {} rather than throwing), and writes serialized
 * through a single in-flight promise chain (temp file + rename) so concurrent
 * saves can't interleave and corrupt the file.
 *
 * Keys are stored under the exact names the backend reads from process.env
 * (RECALL_API_KEY, RECALL_API_URL, Bot_User_OAuth_Token, REQUESTY_API_KEY,
 * GetOverview_BASE_URL, GetOverview_Access_Token) so main.js can layer them
 * straight onto process.env before requiring server.js.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

// Resolved by init(); kept module-level so the IPC handlers can call the store
// functions without threading the path through every call.
let filePath = null;

// Serializes writes: each write waits for the previous one to settle.
let writeChain = Promise.resolve();

// Point the store at a directory (Electron's userData, or a temp dir in tests).
function init(dir) {
  filePath = path.join(dir, 'settings.json');
}

// Read and parse the saved settings; never throws. Missing/corrupt → {}.
async function loadSettings() {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('settingsStore: failed to read settings.json, starting empty:', err);
    }
    return {};
  }
}

// Write the full settings object atomically-ish (write temp, then rename) under
// the serialized chain so concurrent saves don't interleave.
function persist(data) {
  writeChain = writeChain.then(async () => {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
  });
  return writeChain;
}

// Merge a patch into the saved settings and persist. Returns the merged object.
async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await persist(next);
  return next;
}

module.exports = {
  init,
  loadSettings,
  saveSettings,
};
