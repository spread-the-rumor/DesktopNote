const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
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
// When set (injected at build time via webpack DefinePlugin + GitHub Actions
// secret), the one HTTP call to create_sdk_recording goes to Vercel instead of
// localhost, so API keys never need to be on the user's machine.
const VERCEL_BACKEND_URL = process.env.VERCEL_BACKEND_URL || '';

let mainWindow = null;
let backendServer = null;
// True once RecallAiSdk.init() has been called. shutdown() throws on some SDK
// versions if init() never ran (e.g. the app quit before whenReady finished),
// so we gate the teardown on this.
let sdkInited = false;
// Guards the before-quit teardown against double-invocation: quitting fires
// window-all-closed → app.quit() → before-quit, and an explicit quit fires it
// again. Closing an already-closed server / shutting an already-shut SDK throws.
let didTeardown = false;
// Set once the app starts quitting. On shutdown the Recall SDK's native agent
// (and the backend's sockets) can be mid-write when their pipe is torn down,
// which surfaces as an asynchronous, uncatchable `write EPIPE` / `ECONNRESET`
// on the stream's write callback — Electron then shows it as a "JavaScript
// error in the main process" dialog on close. We use this flag to swallow ONLY
// those benign socket errors during quit (see the uncaughtException handler).
let isQuitting = false;
// windowId of an in-progress manual "Huddle" recording (null when idle). The
// Recall SDK identifies a desktop-audio session the same way it does a detected
// meeting window — by a windowId — so we hold onto it to stop the recording.
let huddleWindowId = null;
// windowId of a meeting that has been DETECTED but not yet started by the user.
// We no longer auto-record on detection: instead we stash the id here, show the
// "Meeting Detected" popup, and wait for the user to start (start-detected-recording)
// or dismiss (dismiss-detected-meeting). Cleared on start/dismiss/close.
let detectedWindowId = null;
// windowId of whatever recording is currently active (a detected meeting OR a
// huddle), so a single stop path can stop either. Set at start, cleared on stop.
let activeWindowId = null;
// The frameless "Meeting Detected" popup BrowserWindow (null when not shown).
let popupWindow = null;
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

// Shared start path: fetch an upload token from the backend and start recording
// the given window. Used by both the user-initiated detected-meeting start and
// the manual Huddle. The upload id is tracked so `recording-ended` can poll
// Recall for the finished media (see pendingUploadIds / processCompletedUpload).
const startRecordingForWindow = async (windowId) => {
  const apiBase = VERCEL_BACKEND_URL || `http://localhost:${BACKEND_PORT}`;
  const res = await fetch(`${apiBase}/api/create_sdk_recording`, {
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
  if (payload.id) {
    pendingUploadIds.push(payload.id);
  }
};

// Tear down the "Meeting Detected" popup if it's open.
const closeDetectionPopup = () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.close();
  }
  popupWindow = null;
};

// Show the Granola-style "Meeting Detected" popup: a small frameless,
// always-on-top card pinned to the top-right of the primary display. It stays
// up until the user starts recording or dismisses it (or the meeting closes).
// `meetingInfo` carries display text (e.g. the source app/browser name).
const createDetectionPopup = (meetingInfo = {}) => {
  closeDetectionPopup();

  const POPUP_W = 380;
  const POPUP_H = 92;
  const MARGIN = 16;
  const workArea = screen.getPrimaryDisplay().workArea;

  popupWindow = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    x: workArea.x + workArea.width - POPUP_W - MARGIN,
    y: workArea.y + MARGIN,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: POPUP_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  // Float above full-screen apps (e.g. a maximized meeting window).
  popupWindow.setAlwaysOnTop(true, 'screen-saver');
  popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popupWindow.loadURL(POPUP_WINDOW_WEBPACK_ENTRY);

  // Send the meeting info once the popup's renderer is ready to receive it.
  popupWindow.webContents.on('did-finish-load', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('meeting-info', meetingInfo);
      popupWindow.showInactive();
    }
  });

  popupWindow.on('closed', () => {
    popupWindow = null;
  });
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
      await startRecordingForWindow(windowId);
      huddleWindowId = windowId;
      activeWindowId = windowId;
      sendToRenderer('status', { type: 'recording-started' });
      return { ok: true };
    } catch (err) {
      console.error('start-huddle error:', err);
      huddleWindowId = null;
      return { ok: false, error: String(err) };
    }
  });

  // User-initiated start of a DETECTED meeting (the popup or the in-app
  // "Start Recording" button). Reuses the same pipeline as the huddle; the only
  // difference is the windowId comes from the detected meeting, not a desktop
  // audio session. Closes the popup and clears the pending detected id on start.
  ipcMain.handle('start-detected-recording', async () => {
    if (!detectedWindowId) {
      return { ok: false, error: 'No detected meeting to record' };
    }
    const windowId = detectedWindowId;
    try {
      await startRecordingForWindow(windowId);
      activeWindowId = windowId;
      detectedWindowId = null;
      closeDetectionPopup();
      sendToRenderer('status', { type: 'recording-started' });
      return { ok: true };
    } catch (err) {
      console.error('start-detected-recording error:', err);
      return { ok: false, error: String(err) };
    }
  });

  // User dismissed the "Meeting Detected" popup without recording: drop the
  // pending detected meeting and close the popup. No recording happens.
  ipcMain.handle('dismiss-detected-meeting', async () => {
    detectedWindowId = null;
    closeDetectionPopup();
    sendToRenderer('status', { type: 'meeting-dismissed' });
    return { ok: true };
  });

  // Stop whichever recording is currently active (a detected meeting or a
  // huddle). Both set activeWindowId at start, so one stop path covers both.
  // stop-huddle is kept as an alias so the existing Huddle button wiring works.
  const stopActiveRecording = async () => {
    if (!activeWindowId) {
      return { ok: false, error: 'No active recording' };
    }
    try {
      await RecallAiSdk.stopRecording({ windowId: activeWindowId });
      activeWindowId = null;
      huddleWindowId = null;
      return { ok: true };
    } catch (err) {
      console.error('stop-recording error:', err);
      return { ok: false, error: String(err) };
    }
  };
  ipcMain.handle('stop-recording', stopActiveRecording);
  ipcMain.handle('stop-huddle', stopActiveRecording);

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

  RecallAiSdk.addEventListener('meeting-detected', (evt) => {
    // We no longer auto-record. Stash the detected window so the user can opt in,
    // notify the renderer (which shows the in-app "Start Recording" button), and
    // pop up the Granola-style "Meeting Detected" card. Recording actually starts
    // via the start-detected-recording IPC handler.
    console.log('Meeting detected, awaiting user to start recording...');
    detectedWindowId = evt.window.id;
    const source = evt.window?.platform || evt.window?.title || '';
    sendToRenderer('status', { type: 'meeting-detected' });
    createDetectionPopup({ source });
  });

  // On Windows the meeting URL is often absent in `meeting-detected` and only
  // arrives here, so we listen for updates too.
  RecallAiSdk.addEventListener('meeting-updated', (evt) => {
    console.log('Meeting updated:', evt.window?.url || '(no url yet)');
    // Keep the pending detected window fresh: on Windows/Meet the usable window
    // handle + URL often arrive here, AFTER meeting-detected. If the user hasn't
    // started recording yet (detectedWindowId still set), record against THIS
    // (current) id, not the early one — recording a stale window makes Recall
    // fail to attach to the meeting and emit only "Host" speaker labels. Once
    // recording starts, start-detected-recording clears detectedWindowId, so an
    // in-progress recording is never disturbed by a later update.
    if (detectedWindowId && evt.window?.id) {
      detectedWindowId = evt.window.id;
    }
    sendToRenderer('status', { type: 'meeting-updated', url: evt.window?.url });
  });

  RecallAiSdk.addEventListener('recording-ended', () => {
    console.log('Meeting finished, waiting for Recall to process...');
    sendToRenderer('status', { type: 'recording-ended' });
    // The recording is over: clear active/detected state and any open popup.
    activeWindowId = null;
    detectedWindowId = null;
    closeDetectionPopup();

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
    // If the meeting closed before the user started recording, drop the pending
    // detected meeting and tear down the "Meeting Detected" popup.
    if (detectedWindowId) {
      detectedWindowId = null;
      closeDetectionPopup();
    }
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
  // Mark the SDK as initialized so before-quit knows shutdown() is safe to call.
  sdkInited = true;

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
// launch doesn't hit EADDRINUSE from a leftover listener. Each step is guarded
// independently and the whole thing runs at most once (didTeardown), so a
// double quit, a never-initialized SDK, or an already-closed server can't throw
// an uncaught error on close.
app.on('before-quit', () => {
  isQuitting = true;
  if (didTeardown) {
    return;
  }
  didTeardown = true;

  if (sdkInited) {
    try {
      RecallAiSdk.shutdown();
    } catch (err) {
      console.error('SDK shutdown error:', err);
    }
  }

  if (backendServer) {
    try {
      backendServer.close();
    } catch (err) {
      console.error('backend close error:', err);
    }
    backendServer = null;
  }
});

// Last-resort guard for the teardown race described on `isQuitting` above. A
// failed socket write from the SDK's native agent (or a backend connection)
// completes asynchronously, so it escapes the synchronous try/catch in
// before-quit and bubbles up as an uncaught exception — which Electron renders
// as an alarming "A JavaScript error occurred in the main process" dialog as
// the app closes. We swallow ONLY connection-teardown errors (EPIPE,
// ECONNRESET, ECONNABORTED) and ONLY while quitting; anything else, or any
// error outside of quit, is re-thrown so real bugs still surface loudly.
const BENIGN_SHUTDOWN_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED']);
process.on('uncaughtException', (err) => {
  if (isQuitting && err && BENIGN_SHUTDOWN_CODES.has(err.code)) {
    console.warn(`Ignoring ${err.code} during shutdown:`, err.message);
    return;
  }
  // Not a shutdown-race socket error: this is a genuine bug. Log it and exit
  // non-zero so it still fails loudly (rather than being silently swallowed),
  // matching Electron's default uncaught-exception behavior.
  console.error('Uncaught exception:', err);
  app.exit(1);
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
