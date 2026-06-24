/**
 * Local meeting-history store. Persists every completed meeting to a single
 * JSON file in Electron's userData dir — no database, no cloud. The shape is
 * { meetings: [ <meeting> ] }; namespaced under a top-level object so the
 * schema can grow later.
 *
 * All reads are forgiving (a missing or corrupt file yields { meetings: [] }
 * rather than throwing) and all writes are serialized through a single
 * in-flight promise chain, so the renderer's debounced auto-saves can't
 * interleave and corrupt the file.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

// Resolved by init(); kept module-level so the IPC handlers can call the
// store functions without threading the path through every call.
let filePath = null;

// Serializes writes: each write waits for the previous one to settle.
let writeChain = Promise.resolve();

// Point the store at a directory (Electron's userData, or a temp dir in tests).
function init(dir) {
  filePath = path.join(dir, 'meetings.json');
}

// Read and parse the raw store; never throws. Missing/corrupt → { meetings: [] }.
// This returns ALL meetings, including trashed ones (those with a `deletedAt`
// timestamp). Callers that only want live notes use loadMeetings(); the trash
// view uses loadTrash().
async function loadAll() {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return { meetings: Array.isArray(data.meetings) ? data.meetings : [] };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('store: failed to read meetings.json, starting empty:', err);
    }
    return { meetings: [] };
  }
}

// Live meetings only — those NOT in the trash (no `deletedAt`). This is what
// the sidebar list reads, so soft-deleted notes disappear from history.
async function loadMeetings() {
  const { meetings } = await loadAll();
  return { meetings: meetings.filter((m) => !m.deletedAt) };
}

// Trashed meetings only — those soft-deleted (have `deletedAt`), newest-trashed
// first. Powers the trash section in the sidebar.
async function loadTrash() {
  const { meetings } = await loadAll();
  return {
    meetings: meetings
      .filter((m) => m.deletedAt)
      .sort((a, b) => b.deletedAt - a.deletedAt),
  };
}

// Write the full store atomically-ish (write temp, then rename) under the
// serialized chain so concurrent saves don't interleave.
function persist(data) {
  writeChain = writeChain.then(async () => {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
  });
  return writeChain;
}

// Add a new meeting or replace an existing one (matched by id). Returns the
// saved meeting.
async function upsertMeeting(meeting) {
  const { meetings } = await loadAll();
  const idx = meetings.findIndex((m) => m.id === meeting.id);
  if (idx === -1) {
    meetings.push(meeting);
  } else {
    meetings[idx] = { ...meetings[idx], ...meeting };
  }
  await persist({ meetings });
  return meeting;
}

// Merge a patch into an existing meeting, bumping updatedAt. Returns the
// updated meeting, or null if no meeting has that id.
async function updateMeeting(id, patch) {
  const { meetings } = await loadAll();
  const idx = meetings.findIndex((m) => m.id === id);
  if (idx === -1) {
    return null;
  }
  meetings[idx] = { ...meetings[idx], ...patch, updatedAt: Date.now() };
  await persist({ meetings });
  return meetings[idx];
}

// Soft-delete a meeting by id: move it to the trash by stamping `deletedAt`
// rather than removing it, so it can be restored. Returns { ok: true }
// regardless of whether it existed.
async function deleteMeeting(id) {
  const { meetings } = await loadAll();
  const idx = meetings.findIndex((m) => m.id === id);
  if (idx !== -1) {
    meetings[idx] = { ...meetings[idx], deletedAt: Date.now() };
    await persist({ meetings });
  }
  return { ok: true };
}

// Restore a trashed meeting by clearing its `deletedAt`. Returns { ok: true }
// regardless of whether it existed (or was in the trash).
async function restoreMeeting(id) {
  const { meetings } = await loadAll();
  const idx = meetings.findIndex((m) => m.id === id);
  if (idx !== -1 && meetings[idx].deletedAt) {
    const { deletedAt, ...rest } = meetings[idx];
    meetings[idx] = rest;
    await persist({ meetings });
  }
  return { ok: true };
}

// Permanently remove a meeting by id (the old hard-delete behavior). Used by
// the trash's "Delete forever". Returns { ok: true } regardless.
async function permanentlyDeleteMeeting(id) {
  const { meetings } = await loadAll();
  const next = meetings.filter((m) => m.id !== id);
  await persist({ meetings: next });
  return { ok: true };
}

module.exports = {
  init,
  loadMeetings,
  loadTrash,
  upsertMeeting,
  updateMeeting,
  deleteMeeting,
  restoreMeeting,
  permanentlyDeleteMeeting,
};
