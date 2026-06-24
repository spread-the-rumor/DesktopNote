// Preload for the "Meeting Detected" popup window. Exposes only the two actions
// the popup needs (start the detected recording / dismiss the popup) plus a way
// to receive the meeting info the main process sends after load. No Node APIs
// are leaked — same contextBridge pattern as preload.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  // Start recording the detected meeting — returns { ok } | { ok:false, error }.
  startRecording: () => ipcRenderer.invoke('start-detected-recording'),
  // Dismiss the popup without recording.
  dismiss: () => ipcRenderer.invoke('dismiss-detected-meeting'),
  // Receive the meeting info ({ source }) the main process sends on load.
  onMeetingInfo: (callback) =>
    ipcRenderer.on('meeting-info', (_event, info) => callback(info)),
});
