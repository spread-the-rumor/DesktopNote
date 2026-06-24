const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const RecallAiSdk = require('@recallai/desktop-sdk');
const { updateElectronApp } = require('update-electron-app');
const store = require('./store');
const settingsStore = require('./settingsStore');

// The backend (server.js) reads its API keys into frozen constants at require()
// time, so it must NOT be required until after we've loaded the user's saved
// settings into process.env (see app.whenReady below). Hence: lazy, not a
// top-level require. Assigned once, then used as before via backend.*.
let backend = null;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Auto-update from GitHub Releases via the free update.electron.org feed.
// Only runs in packaged builds — in dev (`npm start`) there is no release feed
// to hit. notifyUser:true shows the built-in download-then-restart prompt.
if (app.isPackaged) {
  updateElectronApp({
    repo: 'spread-the-rumor/DesktopNote',
    updateInterval: '1 hour',
    notifyUser: true,
  });
}

// Electron Forge's webpack plugin runs its renderer dev server on port 3000,
// so the backend must use a different port to avoid an EADDRINUSE clash that
// would leave our API routes unregistered (and meeting-detected fetches 404ing).
const BACKEND_PORT = 3100;

let mainWindow = null;
let backendServer = null;
// windowId of an in-progress manual "Huddle" recording (null when idle). The
// Recall SDK identifies a desktop-audio session the same way it does a detected
// meeting window — by a windowId — so we hold onto it to stop the recording.
let huddleWindowId = null;
// desktop_sdk_upload ids of recordings that have started but not yet been
// processed. We have no public webhook anymore: instead, on `recording-ended`
// we drain this list and poll Recall for each upload's finished media (see
// backend.processCompletedUpload). `recording-ended`'s payload doesn't carry the
// upload id, so we track ids started since the last drain. The backend dedups by
// the resolved recording id, so draining the whole list on each end is safe.
const pendingUploadIds = [];

// Send a message to the renderer if the window exists.
const sendToRenderer = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

// Best-effort meeting timestamp: the first word's absolute time, else now.
const meetingDate = (transcript) => {
  const absolute = Array.isArray(transcript)
    ? transcript[0]?.words?.[0]?.start_timestamp?.absolute
    : null;
  const date = absolute ? new Date(absolute) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

// Build the persisted meeting object from a recording-complete payload. The
// editable note `content` starts as the AI summary; the original `summary` is
// also kept so an edited note can be told apart from the AI text.
const buildMeeting = ({ recordingId, videoUrl, transcript, summary }) => {
  const date = meetingDate(transcript);
  const now = Date.now();
  const title = `Meeting · ${date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
  return {
    id: recordingId,
    recordingId,
    title,
    date: date.toISOString(),
    content: typeof summary === 'string' ? summary : '',
    summary: typeof summary === 'string' ? summary : '',
    transcript: transcript || null,
    videoUrl: videoUrl || null,
    // Q&A thread for the per-meeting AI chat; starts empty.
    chat: [],
    createdAt: now,
    updatedAt: now,
  };
};

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // DevTools is not opened automatically; open it manually with Ctrl+Shift+I.
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(async () => {
  const userData = app.getPath('userData');

  // Load the user's saved API keys (from the in-app Settings view) and layer
  // them onto process.env BEFORE requiring server.js — the backend freezes its
  // keys into constants at require() time, so this ordering is what makes the
  // packaged app (which has no .env) actually able to reach Recall once a key
  // has been entered. Done first so nothing else races it.
  settingsStore.init(userData);
  const settings = await settingsStore.loadSettings();
  for (const [key, value] of Object.entries(settings)) {
    if (value) process.env[key] = value;
  }

  // Now safe to require the backend: it reads the env we just populated.
  backend = require('./server');

  // Start the local backend that bridges the app to the Recall.ai API.
  // start() resolves to null on a port clash (it never throws), so a stale
  // process holding the port no longer crashes the app.
  backendServer = await backend.start(BACKEND_PORT);
  if (!backendServer) {
    console.warn(`Continuing without a new backend (an existing one may be serving port ${BACKEND_PORT}).`);
  }

  // Persist meeting history under Electron's per-user userData dir.
  store.init(userData);

  // When a recording finishes processing, persist it to the local history
  // store first, then forward the *saved meeting* (not the raw payload) so the
  // renderer and disk agree on shape.
  backend.setRecordingCompleteHandler(async (result) => {
    try {
      const meeting = await store.upsertMeeting(buildMeeting(result));
      sendToRenderer('recording-complete', meeting);
    } catch (err) {
      console.error('failed to persist meeting:', err);
      // Still surface the meeting in-session even if the write failed.
      sendToRenderer('recording-complete', buildMeeting(result));
    }
  });

  // History IPC: list/update/delete persisted meetings.
  ipcMain.handle('list-meetings', async () => store.loadMeetings());
  ipcMain.handle('update-meeting', async (_event, { id, patch }) => {
    try {
      const meeting = await store.updateMeeting(id, patch);
      return meeting ? { ok: true, meeting } : { ok: false, error: 'Meeting not found' };
    } catch (err) {
      console.error('update-meeting error:', err);
      return { ok: false, error: String(err) };
    }
  });
  // Soft-delete: move the meeting to the trash (recoverable).
  ipcMain.handle('delete-meeting', async (_event, { id }) => {
    try {
      return await store.deleteMeeting(id);
    } catch (err) {
      console.error('delete-meeting error:', err);
      return { ok: false, error: String(err) };
    }
  });
  // Trash IPC: list trashed meetings, restore one, or delete one forever.
  ipcMain.handle('list-trash', async () => store.loadTrash());
  ipcMain.handle('restore-meeting', async (_event, { id }) => {
    try {
      return await store.restoreMeeting(id);
    } catch (err) {
      console.error('restore-meeting error:', err);
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle('delete-meeting-permanent', async (_event, { id }) => {
    try {
      return await store.permanentlyDeleteMeeting(id);
    } catch (err) {
      console.error('delete-meeting-permanent error:', err);
      return { ok: false, error: String(err) };
    }
  });

  // Settings IPC: the in-app replacement for .env. get-settings returns the
  // saved keys for the Settings view; save-settings persists them and layers
  // them onto process.env so call-time readers (summarize/chat/extract) pick
  // them up live. The Recall/Slack/GetOverview frozen constants in server.js do
  // NOT update mid-session, so the renderer prompts a restart for those.
  ipcMain.handle('get-settings', async () => {
    try {
      return { ok: true, settings: await settingsStore.loadSettings() };
    } catch (err) {
      console.error('get-settings error:', err);
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle('save-settings', async (_event, patch) => {
    try {
      const settings = await settingsStore.saveSettings(patch || {});
      for (const [key, value] of Object.entries(patch || {})) {
        if (value) process.env[key] = value;
      }
      return { ok: true, settings };
    } catch (err) {
      console.error('save-settings error:', err);
      return { ok: false, error: String(err) };
    }
  });
  // Relaunch the app — used by the Settings "Restart now" affordance so a
  // changed Recall key (a frozen constant in server.js) takes effect.
  ipcMain.handle('restart-app', () => {
    app.relaunch();
    app.quit();
  });

  // The running app version (from package.json), shown in the sidebar — also a
  // visible marker that an auto-update applied.
  ipcMain.handle('get-app-version', () => app.getVersion());

  // Renderer → main → backend: post the current transcript to Slack on demand.
  ipcMain.handle('send-to-slack', async (_event, payload) => backend.sendToSlack(payload));

  // Renderer → main → backend: list Slack channels for the send-to dropdown.
  ipcMain.handle('list-slack-channels', async () => backend.listSlackChannels());

  // Renderer → main → backend: list Slack people for DM targets in the dropdown.
  ipcMain.handle('list-slack-users', async () => backend.listSlackUsers());

  // Renderer → main → backend: answer a chat question about a meeting.
  ipcMain.handle('ask-meeting', async (_event, payload) => backend.askMeeting(payload));

  // Renderer → main → backend: GetOverview (internal PM tool) integration —
  // list projects for the dropdown, create tasks from action items, submit the
  // summary/transcript, and AI-extract structured action items for the editor.
  ipcMain.handle('list-getoverview-projects', async () => backend.listGetOverviewProjects());
  ipcMain.handle('create-getoverview-task', async (_event, payload) => backend.createGetOverviewTask(payload));
  ipcMain.handle('send-getoverview-transcript', async (_event, payload) => backend.sendTranscriptToGetOverview(payload));
  ipcMain.handle('extract-action-items', async (_event, payload) => backend.extractActionItems(payload));

  // Manual "Huddle" recording: capture the screen + desktop/mic audio without a
  // detected meeting window. This is the manual analogue of `meeting-detected`
  // — it gets a windowId from `prepareDesktopAudioRecording`, fetches an upload
  // token from the same backend route, and starts recording. The recording then
  // rides the identical pipeline (recording-ended → webhook → summary → note).
  ipcMain.handle('start-huddle', async () => {
    try {
      // Desktop-audio session windowId (not tied to any meeting window).
      const windowId = await RecallAiSdk.prepareDesktopAudioRecording();

      const res = await fetch(`http://localhost:${BACKEND_PORT}/api/create_sdk_recording`, {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(`create_sdk_recording returned ${res.status}`);
      }
      const payload = await res.json();

      await RecallAiSdk.startRecording({
        windowId,
        uploadToken: payload.upload_token,
      });
      // Remember the upload id so `recording-ended` can poll Recall for the
      // finished media (replaces the old inbound webhook).
      if (payload.id) {
        pendingUploadIds.push(payload.id);
      }
      huddleWindowId = windowId;
      sendToRenderer('status', { type: 'recording-started' });
      return { ok: true };
    } catch (err) {
      console.error('start-huddle error:', err);
      huddleWindowId = null;
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('stop-huddle', async () => {
    if (!huddleWindowId) {
      return { ok: false, error: 'No active huddle' };
    }
    try {
      await RecallAiSdk.stopRecording({ windowId: huddleWindowId });
      huddleWindowId = null;
      return { ok: true };
    } catch (err) {
      console.error('stop-huddle error:', err);
      return { ok: false, error: String(err) };
    }
  });

  // Save the transcript to a user-chosen location (.txt readable or .json raw).
  ipcMain.handle('save-transcript', async (_event, { recordingId, transcript }) => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `transcript_${recordingId}.txt`,
        filters: [
          { name: 'Text', extensions: ['txt'] },
          { name: 'JSON', extensions: ['json'] },
        ],
      });
      if (canceled || !filePath) {
        return { ok: false, canceled: true };
      }

      const content = filePath.toLowerCase().endsWith('.json')
        ? JSON.stringify({ recordingId, transcript }, null, 2)
        : backend.formatTranscript(transcript);

      await fs.writeFile(filePath, content, 'utf8');
      return { ok: true, path: filePath };
    } catch (err) {
      console.error('save-transcript error:', err);
      return { ok: false, error: String(err) };
    }
  });

  // Download the recording's MP4 from its Recall URL to a user-chosen location.
  ipcMain.handle('save-recording', async (_event, { recordingId, videoUrl }) => {
    if (!videoUrl) {
      return { ok: false, error: 'No video URL available for this recording' };
    }
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `recording_${recordingId}.mp4`,
        filters: [{ name: 'Video', extensions: ['mp4'] }],
      });
      if (canceled || !filePath) {
        return { ok: false, canceled: true };
      }

      const res = await fetch(videoUrl);
      if (!res.ok) {
        return { ok: false, error: `Download failed (${res.status})` };
      }
      // Loads the whole file into memory; fine for typical meeting recordings.
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(filePath, buf);
      return { ok: true, path: filePath };
    } catch (err) {
      console.error('save-recording error:', err);
      return { ok: false, error: String(err) };
    }
  });

  // IMPORTANT: register ALL SDK event listeners BEFORE calling init(). The SDK
  // wires up its detection/event subsystem at init time; listeners added after
  // init() (including meeting-detected) are never connected. This ordering
  // matches Recall's official electron-webpack sample.

  // Surface the SDK's own diagnostic log so we can see why detection does or
  // doesn't fire (e.g. unsupported browser, permissions, join state).
  RecallAiSdk.addEventListener('log', (evt) => {
    console.log(`[Recall:${evt.level}] ${evt.subsystem}/${evt.category}: ${evt.message}`);
  });

  RecallAiSdk.addEventListener('permission-status', (evt) => {
    console.log(`Recall permission status: ${evt.permission} = ${evt.status}`);
  });

  RecallAiSdk.addEventListener('permissions-granted', () => {
    console.log('Recall SDK permissions granted');
    sendToRenderer('status', { type: 'permissions-granted' });
  });

  RecallAiSdk.addEventListener('meeting-detected', async (evt) => {
    try {
      console.log('Meeting detected, starting recording...');
      sendToRenderer('status', { type: 'meeting-detected' });

      const res = await fetch(`http://localhost:${BACKEND_PORT}/api/create_sdk_recording`, {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(`create_sdk_recording returned ${res.status}`);
      }
      const payload = await res.json();

      await RecallAiSdk.startRecording({
        windowId: evt.window.id,
        uploadToken: payload.upload_token,
      });
      // Remember the upload id so `recording-ended` can poll Recall for the
      // finished media (replaces the old inbound webhook).
      if (payload.id) {
        pendingUploadIds.push(payload.id);
      }
      sendToRenderer('status', { type: 'recording-started' });
    } catch (err) {
      console.error('Failed to start recording:', err);
      sendToRenderer('status', { type: 'error', message: String(err) });
    }
  });

  // On Windows the meeting URL is often absent in `meeting-detected` and only
  // arrives here, so we listen for updates too.
  RecallAiSdk.addEventListener('meeting-updated', (evt) => {
    console.log('Meeting updated:', evt.window?.url || '(no url yet)');
    sendToRenderer('status', { type: 'meeting-updated', url: evt.window?.url });
  });

  RecallAiSdk.addEventListener('recording-ended', () => {
    console.log('Meeting finished, waiting for Recall to process...');
    sendToRenderer('status', { type: 'recording-ended' });

    // No inbound webhook anymore: drain the upload ids started since the last
    // end and poll Recall for each one's finished media. processCompletedUpload
    // runs its own (minutes-long) poll, downloads + summarizes, then drives the
    // recording-complete flow via the handler registered above. It dedups by the
    // resolved recording id, so draining the whole list is safe. Fire-and-forget.
    const ids = pendingUploadIds.splice(0);
    for (const uploadId of ids) {
      backend.processCompletedUpload(uploadId).catch((err) => {
        console.error('processCompletedUpload failed for', uploadId, err);
      });
    }
  });

  RecallAiSdk.addEventListener('meeting-closed', (evt) => {
    console.log('Meeting closed');
    sendToRenderer('status', { type: 'meeting-closed' });
  });

  RecallAiSdk.addEventListener('error', (evt) => {
    console.error('Recall SDK error:', evt);
    sendToRenderer('status', { type: 'error', message: JSON.stringify(evt) });
  });

  // init() comes LAST, after every listener above is registered.
  RecallAiSdk.init({
    apiUrl: 'https://us-west-2.recall.ai',
    acquirePermissionsOnStartup: ['accessibility', 'microphone', 'screen-capture', 'system-audio'],
  });

  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Release the backend port and shut the SDK down cleanly on exit, so the next
// launch doesn't hit EADDRINUSE from a leftover listener.
app.on('before-quit', () => {
  try {
    RecallAiSdk.shutdown();
  } catch (err) {
    console.error('SDK shutdown error:', err);
  }
  if (backendServer) {
    backendServer.close();
  }
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
