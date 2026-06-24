// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal, safe API to the renderer. No Node APIs are leaked.
contextBridge.exposeInMainWorld('recall', {
  onStatus: (callback) =>
    ipcRenderer.on('status', (_event, payload) => callback(payload)),
  onRecordingComplete: (callback) =>
    ipcRenderer.on('recording-complete', (_event, payload) => callback(payload)),
  // Request/response: returns { ok: true } or { ok: false, error }.
  sendToSlack: (payload) => ipcRenderer.invoke('send-to-slack', payload),
  // List Slack channels for the send-to dropdown — { ok, channels } | { ok:false, error }.
  listSlackChannels: () => ipcRenderer.invoke('list-slack-channels'),
  // List Slack people (DM targets) for the dropdown — { ok, users } | { ok:false, error }.
  listSlackUsers: () => ipcRenderer.invoke('list-slack-users'),
  // Save dialogs — return { ok, path } | { ok:false, canceled } | { ok:false, error }.
  saveTranscript: (payload) => ipcRenderer.invoke('save-transcript', payload),
  saveRecording: (payload) => ipcRenderer.invoke('save-recording', payload),
  // Meeting history — local JSON store.
  listMeetings: () => ipcRenderer.invoke('list-meetings'),
  updateMeeting: (payload) => ipcRenderer.invoke('update-meeting', payload),
  deleteMeeting: (payload) => ipcRenderer.invoke('delete-meeting', payload),
  // Trash — soft-deleted meetings: list, restore, or delete forever.
  listTrash: () => ipcRenderer.invoke('list-trash'),
  restoreMeeting: (payload) => ipcRenderer.invoke('restore-meeting', payload),
  deleteMeetingPermanent: (payload) => ipcRenderer.invoke('delete-meeting-permanent', payload),
  // AI chat about a meeting — returns { ok, answer } | { ok:false, error }.
  askMeeting: (payload) => ipcRenderer.invoke('ask-meeting', payload),
  // GetOverview (internal PM tool) — list projects for the dropdown, create a
  // task from an action item, submit the summary/transcript, and AI-extract
  // structured action items. Each returns { ok, ... } | { ok:false, error }.
  listGetOverviewProjects: () => ipcRenderer.invoke('list-getoverview-projects'),
  createGetOverviewTask: (payload) => ipcRenderer.invoke('create-getoverview-task', payload),
  sendGetOverviewTranscript: (payload) => ipcRenderer.invoke('send-getoverview-transcript', payload),
  extractActionItems: (payload) => ipcRenderer.invoke('extract-action-items', payload),
  // Manual "Huddle" recording — start/stop screen + audio capture.
  // Each returns { ok: true } | { ok: false, error }.
  startHuddle: () => ipcRenderer.invoke('start-huddle'),
  stopHuddle: () => ipcRenderer.invoke('stop-huddle'),
  // Settings — the in-app replacement for .env. get returns { ok, settings };
  // save persists the keys and returns { ok, settings }. restart relaunches the
  // app so a changed Recall API key takes effect.
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('save-settings', payload),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  // The running app version — shown in the sidebar.
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
});
