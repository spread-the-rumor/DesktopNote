// Renderer for the "Meeting Detected" popup. Talks to the main process only via
// the `window.popup` bridge from popupPreload.js. Main closes this window when
// the recording starts or is dismissed, so we don't manage window lifecycle here.

const startBtn = document.getElementById('start-btn');
const startText = startBtn.querySelector('.start-text');
const dismissBtn = document.getElementById('dismiss-btn');
const subtitleEl = document.getElementById('subtitle');

// Show the meeting source (e.g. the browser/app name) when main sends it.
window.popup?.onMeetingInfo((info) => {
  const source = (info && info.source) || '';
  subtitleEl.textContent = source ? `${source}` : 'A meeting is in progress';
});

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startText.textContent = 'Starting…';
  const res = await window.popup?.startRecording();
  // On success main closes this window. On failure, restore the button so the
  // user can retry (or dismiss).
  if (!res?.ok) {
    startBtn.disabled = false;
    startText.textContent = 'Start Recording';
  }
});

dismissBtn.addEventListener('click', () => {
  window.popup?.dismiss();
});
