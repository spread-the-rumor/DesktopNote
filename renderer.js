/**
 * Renderer process. Node integration is disabled; all communication with the
 * main process goes through the `window.recall` bridge defined in preload.js.
 *
 * The UI is a notepad: a sidebar list of past meetings (loaded from the local
 * JSON store) and an editor pane showing the selected meeting's note. The note
 * body is the AI summary as editable text; edits auto-save (debounced) and are
 * what "Send to Slack" sends.
 */

import './index.css';

const statusEl = document.getElementById('status');
const statusTextEl = statusEl.querySelector('.pill-text');
const huddleBtn = document.getElementById('huddle-btn');
const huddleTextEl = huddleBtn.querySelector('.huddle-text');
const notesListEl = document.getElementById('notes-list');
const searchInputEl = document.getElementById('search-input');
const trashToggleEl = document.getElementById('trash-toggle');
const trashCountEl = document.getElementById('trash-count');
const trashListEl = document.getElementById('trash-list');
const emptyStateEl = document.getElementById('empty-state');
const noteEl = document.getElementById('note');
const noteTitleEl = document.getElementById('note-title');
const noteMetaEl = document.getElementById('note-meta');
const editorEl = document.getElementById('simple-editor');
const transcriptViewEl = document.getElementById('transcript-view');
const chatViewEl = document.getElementById('chat-view');
const chatMessagesEl = document.getElementById('chat-messages');
const chatFormEl = document.getElementById('chat-form');
const chatInputEl = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send');
const viewSummaryBtn = document.getElementById('view-summary-btn');
const viewTranscriptBtn = document.getElementById('view-transcript-btn');
const viewChatBtn = document.getElementById('view-chat-btn');
const saveStateEl = document.getElementById('save-state');
const videoLinkEl = document.getElementById('video-link');
const savedPathEl = document.getElementById('saved-path');
const slackBtn = document.getElementById('slack-btn');
const slackBtnText = slackBtn.querySelector('.slack-btn-text');
const slackChannelEl = document.getElementById('slack-channel');
const saveTranscriptBtn = document.getElementById('save-transcript-btn');
const saveRecordingBtn = document.getElementById('save-recording-btn');
// Header sections shown only on the Summary view (hidden on Transcript/Chat).
const noteActionsEl = document.querySelector('.note-actions');
const sendToEl = document.querySelector('.send-to');
// "Send to" destination switcher (Slack | GetOverview).
const destSlackBtn = document.getElementById('dest-slack-btn');
const destGoBtn = document.getElementById('dest-go-btn');
const destSlackPanel = document.getElementById('dest-slack-panel');
const destGoPanel = document.getElementById('dest-go-panel');
// GetOverview (internal PM tool) panel.
const goProjectEl = document.getElementById('go-project');
const goRefreshBtn = document.getElementById('go-refresh-btn');
const goOpenLink = document.getElementById('go-open-link');
const goSendSummaryBtn = document.getElementById('go-send-summary-btn');
const goSendTranscriptBtn = document.getElementById('go-send-transcript-btn');
const goCreateTasksBtn = document.getElementById('go-create-tasks-btn');
const goTasksEl = document.getElementById('go-tasks');
const goTasksRowsEl = document.getElementById('go-tasks-rows');
const goAddRowBtn = document.getElementById('go-add-row-btn');
const goSubmitTasksBtn = document.getElementById('go-submit-tasks-btn');
const goCancelTasksBtn = document.getElementById('go-cancel-tasks-btn');
const goTasksStatusEl = document.getElementById('go-tasks-status');
// Settings view (the in-app replacement for .env).
const settingsBtn = document.getElementById('settings-btn');
const settingsViewEl = document.getElementById('settings-view');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsDoneBtn = document.getElementById('settings-done-btn');
const settingsStatusEl = document.getElementById('settings-status');
// Map each input element to the exact settings/env key it persists under.
const SETTINGS_FIELDS = {
  RECALL_API_KEY: document.getElementById('set-recall-key'),
  RECALL_API_URL: document.getElementById('set-recall-url'),
  REQUESTY_API_KEY: document.getElementById('set-requesty-key'),
  Bot_User_OAuth_Token: document.getElementById('set-slack-token'),
  GetOverview_BASE_URL: document.getElementById('set-go-url'),
  GetOverview_Access_Token: document.getElementById('set-go-token'),
};

// In-memory mirror of the persisted store + the currently open note.
let meetings = [];
let currentId = null;
// In-memory mirror of the trashed (soft-deleted) meetings + whether the trash
// section in the sidebar is expanded.
let trashedMeetings = [];
let trashExpanded = false;
// Which pane the editor shows: the editable summary, or the read-only transcript.
let currentView = 'summary';
// Current sidebar search query (lowercased); empty string = show all meetings.
let searchQuery = '';
// Whether a manual "Huddle" recording is in progress.
let isHuddling = false;
// Loaded GetOverview projects (global control, like the Slack dropdown), keyed
// for the "Open in GetOverview" link lookup.
let goProjects = [];
// The Recall API key as last loaded/saved — used to detect a change on save
// (which requires a restart to take effect) and to drive the "not configured"
// state. Loaded once on startup via refreshConfiguredState().
let lastSavedRecallKey = '';

// ---- Status pill ----

const STATUS_STATES = {
  'permissions-granted': { text: 'Waiting for a meeting…', cls: 'is-waiting' },
  'meeting-detected': { text: 'Meeting detected — starting…', cls: 'is-recording' },
  'recording-started': { text: 'Recording in progress', cls: 'is-recording' },
  'meeting-updated': { text: 'Recording in progress', cls: 'is-recording' },
  'recording-ended': { text: 'Processing transcript…', cls: 'is-waiting' },
  'meeting-closed': { text: 'Processing transcript…', cls: 'is-waiting' },
  error: { text: 'Error', cls: 'is-error' },
};

const setStatus = (text, cls) => {
  statusTextEl.textContent = text;
  statusEl.classList.remove('is-waiting', 'is-recording', 'is-ready', 'is-error');
  statusEl.classList.add(cls);
};

// Reflect whether a Recall API key is configured: with no key the app can't
// record, so the status pill says so and the empty state nudges toward Settings.
const updateConfiguredState = (recallKey) => {
  const configured = Boolean(recallKey);
  huddleBtn.disabled = !configured;
  const emptySub = emptyStateEl.querySelector('.empty-sub');
  if (!configured) {
    setStatus('Add your Recall API key in Settings', 'is-error');
    if (emptySub) {
      emptySub.textContent =
        'Add your Recall API key in Settings (gear icon, top-left) to detect and record meetings.';
    }
  } else if (statusEl.classList.contains('is-error')) {
    // Clear the "not configured" warning once a key exists.
    setStatus('Waiting for a meeting…', 'is-waiting');
  }
};

// Load the saved settings once on startup to seed lastSavedRecallKey and the
// configured-state UI, without opening the settings view.
const refreshConfiguredState = async () => {
  const res = await window.recall?.getSettings();
  lastSavedRecallKey = res?.settings?.RECALL_API_KEY || '';
  updateConfiguredState(lastSavedRecallKey);
};

// ---- Huddle (manual recording) ----

// Reflect the recording state on the button: "Stop" (red) while recording,
// "Huddle" when idle.
const setHuddleState = (active) => {
  isHuddling = active;
  huddleBtn.classList.toggle('is-recording', active);
  huddleTextEl.textContent = active ? 'Stop' : 'Huddle';
};

huddleBtn.addEventListener('click', async () => {
  if (!window.recall?.startHuddle) {
    return;
  }

  huddleBtn.disabled = true;

  if (!isHuddling) {
    // Start a manual recording.
    huddleTextEl.textContent = 'Starting…';
    const res = await window.recall.startHuddle();
    if (res?.ok) {
      setHuddleState(true);
      setStatus('Recording in progress', 'is-recording');
    } else {
      // Restore the idle button and surface the error briefly in the status.
      setHuddleState(false);
      setStatus(`Huddle failed — ${res?.error || 'unknown error'}`, 'is-error');
    }
  } else {
    // Stop the in-progress recording. The status pill then advances on its own
    // via the existing recording-ended → recording-complete events.
    huddleTextEl.textContent = 'Stopping…';
    const res = await window.recall.stopHuddle();
    if (res?.ok) {
      setHuddleState(false);
    } else {
      // Keep the recording state so the user can retry the stop.
      huddleTextEl.textContent = 'Stop';
      setStatus(`Stop failed — ${res?.error || 'unknown error'}`, 'is-error');
    }
  }

  huddleBtn.disabled = false;
});

// ---- Date formatting ----

// "Today" / "Yesterday" / "Jun 14" — the relative label shown in the list.
const relativeDate = (iso) => {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Full readable timestamp for the note meta line.
const fullDate = (iso) => {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

// ---- Meeting list (sidebar) ----

const sortedMeetings = () =>
  [...meetings].sort((a, b) => new Date(b.date) - new Date(a.date));

// Does a meeting contain the (already-lowercased) query in its title, note
// content, or transcript text? `segmentParts` (defined below for the Transcript
// view) is reused so transcript search text matches what the UI renders. The
// transcript string is built on demand — fine at local-history scale.
const meetingMatches = (meeting, q) => {
  if (!q) {
    return true;
  }
  if ((meeting.title || '').toLowerCase().includes(q)) {
    return true;
  }
  if ((meeting.content || '').toLowerCase().includes(q)) {
    return true;
  }
  if (Array.isArray(meeting.transcript)) {
    const text = meeting.transcript
      .map((seg) => {
        const { speaker, words } = segmentParts(seg);
        return `${speaker} ${words}`;
      })
      .join(' ')
      .toLowerCase();
    if (text.includes(q)) {
      return true;
    }
  }
  return false;
};

const renderMeetingList = () => {
  notesListEl.innerHTML = '';

  if (meetings.length === 0) {
    const p = document.createElement('p');
    p.className = 'notes-empty';
    p.textContent = 'No meetings yet.';
    notesListEl.append(p);
    return;
  }

  const visible = sortedMeetings().filter((m) => meetingMatches(m, searchQuery));

  if (visible.length === 0) {
    const p = document.createElement('p');
    p.className = 'notes-empty';
    p.textContent = `No meetings match “${searchQuery}”.`;
    notesListEl.append(p);
    return;
  }

  for (const meeting of visible) {
    const item = document.createElement('div');
    item.className = 'note-item';
    if (meeting.id === currentId) {
      item.classList.add('active');
    }

    const main = document.createElement('button');
    main.className = 'note-item-main';
    main.type = 'button';

    const title = document.createElement('span');
    title.className = 'note-item-title';
    title.textContent = meeting.title || 'Untitled meeting';

    const date = document.createElement('span');
    date.className = 'note-item-date';
    date.textContent = relativeDate(meeting.date);

    main.append(title, date);
    main.addEventListener('click', () => showEditor(meeting.id));

    const del = document.createElement('button');
    del.className = 'note-item-delete';
    del.type = 'button';
    del.title = 'Delete note';
    del.textContent = '🗑';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNote(meeting.id);
    });

    item.append(main, del);
    notesListEl.append(item);
  }
};

// ---- Trash (soft-deleted meetings) ----

// Render the trash count badge + (when expanded) the list of trashed meetings,
// each with Restore and Delete-forever actions.
const renderTrash = () => {
  // Count badge — hidden when the trash is empty.
  if (trashedMeetings.length) {
    trashCountEl.textContent = String(trashedMeetings.length);
    trashCountEl.hidden = false;
  } else {
    trashCountEl.hidden = true;
  }

  // Reflect expanded state on the toggle + list visibility.
  trashToggleEl.setAttribute('aria-expanded', String(trashExpanded));
  trashListEl.hidden = !trashExpanded;
  if (!trashExpanded) {
    return;
  }

  trashListEl.innerHTML = '';

  if (trashedMeetings.length === 0) {
    const p = document.createElement('p');
    p.className = 'trash-empty';
    p.textContent = 'Trash is empty.';
    trashListEl.append(p);
    return;
  }

  for (const meeting of trashedMeetings) {
    const item = document.createElement('div');
    item.className = 'trash-item';

    const info = document.createElement('div');
    info.className = 'trash-item-info';

    const title = document.createElement('span');
    title.className = 'trash-item-title';
    title.textContent = meeting.title || 'Untitled meeting';

    const date = document.createElement('span');
    date.className = 'trash-item-date';
    date.textContent = `Deleted ${relativeDate(meeting.deletedAt)}`;

    info.append(title, date);

    const restore = document.createElement('button');
    restore.className = 'trash-item-btn restore';
    restore.type = 'button';
    restore.title = 'Restore meeting';
    restore.textContent = '↩';
    restore.addEventListener('click', () => restoreMeeting(meeting.id));

    const purge = document.createElement('button');
    purge.className = 'trash-item-btn purge';
    purge.type = 'button';
    purge.title = 'Delete forever';
    purge.textContent = '✕';
    purge.addEventListener('click', () => purgeMeeting(meeting.id));

    item.append(info, restore, purge);
    trashListEl.append(item);
  }
};

// Restore a trashed meeting back into the live history, opening it.
const restoreMeeting = async (id) => {
  const res = await window.recall?.restoreMeeting({ id });
  if (!res?.ok) {
    return;
  }
  const idx = trashedMeetings.findIndex((m) => m.id === id);
  let restored = null;
  if (idx !== -1) {
    restored = trashedMeetings[idx];
    delete restored.deletedAt;
    trashedMeetings.splice(idx, 1);
    meetings.push(restored);
  }
  renderTrash();
  if (restored) {
    showEditor(restored.id);
  } else {
    renderMeetingList();
  }
};

// Permanently delete a trashed meeting — no recovery after this.
const purgeMeeting = async (id) => {
  const res = await window.recall?.deleteMeetingPermanent({ id });
  if (!res?.ok) {
    return;
  }
  trashedMeetings = trashedMeetings.filter((m) => m.id !== id);
  renderTrash();
};

// ---- Transcript view (read-only) ----

// Extract "speaker" and joined "words" from a Recall transcript segment.
// Mirrors formatTranscript (server.js) and normalizeSegment (summarize.js).
const segmentParts = (segment) => {
  const speaker = segment.speaker || segment.participant?.name || 'Speaker';
  const words = Array.isArray(segment.words)
    ? segment.words.map((w) => w.text).join(' ')
    : segment.text || '';
  return { speaker, words };
};

// Render the full transcript as read-only "speaker → words" blocks.
const renderTranscript = (transcript) => {
  transcriptViewEl.innerHTML = '';

  if (!Array.isArray(transcript) || transcript.length === 0) {
    const p = document.createElement('p');
    p.className = 'transcript-empty';
    p.textContent = 'No transcript was captured for this meeting.';
    transcriptViewEl.append(p);
    return;
  }

  for (const segment of transcript) {
    const { speaker, words } = segmentParts(segment);
    const block = document.createElement('div');
    block.className = 'seg';

    const speakerEl = document.createElement('span');
    speakerEl.className = 'speaker';
    speakerEl.textContent = speaker;

    const wordsEl = document.createElement('p');
    wordsEl.className = 'words';
    wordsEl.textContent = words;

    block.append(speakerEl, wordsEl);
    transcriptViewEl.append(block);
  }
};

// Switch between the editable summary, the read-only transcript, and the chat.
const setView = (view) => {
  currentView = view;
  editorEl.hidden = view !== 'summary';
  transcriptViewEl.hidden = view !== 'transcript';
  chatViewEl.hidden = view !== 'chat';
  // The action buttons (recording / transcript / send-to) act on the summary,
  // so they only show on the Summary view — Transcript shows only the
  // transcript, Chat shows only the chat.
  noteActionsEl.hidden = view !== 'summary';
  sendToEl.hidden = view !== 'summary';
  viewSummaryBtn.classList.toggle('is-active', view === 'summary');
  viewTranscriptBtn.classList.toggle('is-active', view === 'transcript');
  viewChatBtn.classList.toggle('is-active', view === 'chat');
  if (view === 'chat') {
    chatInputEl.focus();
    scrollChatToBottom();
  }
};

viewSummaryBtn.addEventListener('click', () => setView('summary'));
viewTranscriptBtn.addEventListener('click', () => setView('transcript'));
viewChatBtn.addEventListener('click', () => setView('chat'));

// ---- "Send to" destination switcher (Slack | GetOverview) ----

// Show one destination's controls at a time. Mirrors setView; defaults to
// Slack. The toggle reuses the .toggle-opt active styling.
const setDest = (dest) => {
  destSlackPanel.hidden = dest !== 'slack';
  destGoPanel.hidden = dest !== 'getoverview';
  destSlackBtn.classList.toggle('is-active', dest === 'slack');
  destGoBtn.classList.toggle('is-active', dest === 'getoverview');
};

destSlackBtn.addEventListener('click', () => setDest('slack'));
destGoBtn.addEventListener('click', () => setDest('getoverview'));

// ---- Chat ----

const scrollChatToBottom = () => {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
};

// Append a message bubble; returns the element so a transient one can be
// replaced in place. `role` is 'user' | 'ai'; `thinking` styles a placeholder.
const appendChatBubble = (role, text, thinking = false) => {
  const bubble = document.createElement('div');
  bubble.className = `chat-msg is-${role === 'user' ? 'user' : 'ai'}`;
  if (thinking) {
    bubble.classList.add('is-thinking');
  }
  bubble.textContent = text;
  chatMessagesEl.append(bubble);
  scrollChatToBottom();
  return bubble;
};

// Render the persisted Q&A thread for a meeting.
const renderChat = (meeting) => {
  chatMessagesEl.innerHTML = '';
  const thread = Array.isArray(meeting.chat) ? meeting.chat : [];

  if (thread.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'chat-empty';
    hint.textContent = 'Ask the AI anything about this meeting — it answers from the transcript.';
    chatMessagesEl.append(hint);
    return;
  }

  for (const msg of thread) {
    appendChatBubble(msg.role === 'user' ? 'user' : 'ai', msg.content);
  }
};

chatFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const meeting = findMeeting(currentId);
  const question = chatInputEl.value.trim();
  if (!meeting || !question || !window.recall?.askMeeting) {
    return;
  }

  // Ensure an in-memory thread exists (older notes may lack the field).
  if (!Array.isArray(meeting.chat)) {
    meeting.chat = [];
  }

  // Clear the empty-state hint on the first question.
  if (meeting.chat.length === 0) {
    chatMessagesEl.innerHTML = '';
  }

  // Show the question immediately; capture the history that preceded it.
  const history = [...meeting.chat];
  appendChatBubble('user', question);
  chatInputEl.value = '';
  chatInputEl.disabled = true;
  chatSendBtn.disabled = true;
  const thinking = appendChatBubble('ai', 'Thinking…', true);

  const res = await window.recall.askMeeting({
    transcript: meeting.transcript,
    question,
    history,
  });
  const answer = res?.ok ? res.answer : `Chat failed — ${res?.error || 'unknown error'}`;

  // Replace the placeholder with the real answer and persist the thread.
  thinking.classList.remove('is-thinking');
  thinking.textContent = answer;
  scrollChatToBottom();

  meeting.chat.push({ role: 'user', content: question });
  meeting.chat.push({ role: 'assistant', content: answer });

  const saved = await window.recall.updateMeeting({
    id: meeting.id,
    patch: { chat: meeting.chat },
  });
  if (saved?.ok && saved.meeting) {
    const idx = meetings.findIndex((m) => m.id === meeting.id);
    if (idx !== -1) {
      meetings[idx] = saved.meeting;
    }
  }

  chatInputEl.disabled = false;
  chatSendBtn.disabled = false;
  chatInputEl.focus();
});

// ---- Editor ----

const findMeeting = (id) => meetings.find((m) => m.id === id) || null;

// Set an action button's visible label without clobbering its inline-SVG icon:
// write to the inner `.action-text` span when present, else fall back to the
// whole button's textContent (for plain-text buttons).
const setActionLabel = (btn, text) => {
  const span = btn.querySelector('.action-text');
  if (span) {
    span.textContent = text;
  } else {
    btn.textContent = text;
  }
};

const showEditor = (id) => {
  const meeting = findMeeting(id);
  if (!meeting) {
    return;
  }
  currentId = id;

  settingsViewEl.hidden = true;
  emptyStateEl.hidden = true;
  noteEl.hidden = false;

  noteTitleEl.value = meeting.title || '';
  noteMetaEl.textContent = `${fullDate(meeting.date)} · ${meeting.recordingId}`;
  editorEl.value = meeting.content || '';

  // Fill the read-only transcript pane and the chat thread, then default the
  // view to the summary.
  renderTranscript(meeting.transcript);
  renderChat(meeting);
  setView('summary');

  // Action buttons reflect this meeting.
  slackBtn.disabled = false;
  slackBtn.classList.remove('is-sent', 'is-error');
  slackBtnText.textContent = 'Send to Slack';

  saveTranscriptBtn.hidden = !meeting.transcript;
  saveTranscriptBtn.disabled = false;
  saveTranscriptBtn.classList.remove('is-done', 'is-error');
  setActionLabel(saveTranscriptBtn, 'Transcript');

  saveRecordingBtn.hidden = !meeting.videoUrl;
  saveRecordingBtn.disabled = false;
  saveRecordingBtn.classList.remove('is-done', 'is-error');
  setActionLabel(saveRecordingBtn, 'Download');

  // Reset to the Slack destination for each opened note (consistent with
  // defaulting the view to Summary).
  setDest('slack');

  // Reset the GetOverview controls for the newly opened note (the project
  // dropdown is global and untouched; only the per-note send/task state resets).
  goSendSummaryBtn.disabled = false;
  goSendSummaryBtn.classList.remove('is-done', 'is-error');
  goSendSummaryBtn.textContent = 'Send summary';
  goSendTranscriptBtn.disabled = false;
  goSendTranscriptBtn.classList.remove('is-done', 'is-error');
  goSendTranscriptBtn.textContent = 'Send full transcript';
  goSendTranscriptBtn.hidden = !meeting.transcript;
  closeTasksEditor();

  // The video "play" link opens the recording in the browser; the Download
  // button (saveRecordingBtn) saves the mp4. Both hidden when there's no video.
  if (meeting.videoUrl) {
    videoLinkEl.hidden = false;
    videoLinkEl.href = meeting.videoUrl;
  } else {
    videoLinkEl.hidden = true;
    videoLinkEl.removeAttribute('href');
  }

  saveStateEl.textContent = '';
  savedPathEl.hidden = true;
  savedPathEl.textContent = '';

  renderMeetingList();
};

const showEmpty = () => {
  currentId = null;
  settingsViewEl.hidden = true;
  noteEl.hidden = true;
  emptyStateEl.hidden = false;
  renderMeetingList();
};

// ---- Settings view (the in-app replacement for .env) ----

// Show the settings pane in place of the note/empty-state, populated from the
// saved settings. Done/Save returns to the prior note (or empty state).
const showSettings = async () => {
  noteEl.hidden = true;
  emptyStateEl.hidden = true;
  settingsViewEl.hidden = false;
  settingsStatusEl.textContent = '';
  settingsStatusEl.classList.remove('is-ok', 'is-error');

  const res = await window.recall?.getSettings();
  const settings = res?.settings || {};
  for (const [key, input] of Object.entries(SETTINGS_FIELDS)) {
    if (input) input.value = settings[key] || '';
  }
};

// Leave settings: reopen the current note, else the newest, else empty state.
const closeSettings = () => {
  settingsViewEl.hidden = true;
  if (currentId && findMeeting(currentId)) {
    showEditor(currentId);
  } else {
    const newest = sortedMeetings()[0];
    if (newest) showEditor(newest.id);
    else showEmpty();
  }
};

settingsBtn.addEventListener('click', () => {
  showSettings();
});

settingsDoneBtn.addEventListener('click', () => {
  closeSettings();
});

settingsSaveBtn.addEventListener('click', async () => {
  if (!window.recall?.saveSettings) return;

  // Collect a patch of every field (trimmed). Empty strings are saved too, so a
  // user can clear a key.
  const patch = {};
  for (const [key, input] of Object.entries(SETTINGS_FIELDS)) {
    if (input) patch[key] = input.value.trim();
  }
  const recallKeyChanged = patch.RECALL_API_KEY !== (lastSavedRecallKey || '');

  settingsSaveBtn.disabled = true;
  settingsStatusEl.classList.remove('is-ok', 'is-error');
  settingsStatusEl.textContent = 'Saving…';

  const res = await window.recall.saveSettings(patch);
  settingsSaveBtn.disabled = false;

  if (!res?.ok) {
    settingsStatusEl.classList.add('is-error');
    settingsStatusEl.textContent = `Couldn't save — ${res?.error || 'unknown error'}`;
    return;
  }

  lastSavedRecallKey = patch.RECALL_API_KEY;
  updateConfiguredState(patch.RECALL_API_KEY);
  settingsStatusEl.classList.add('is-ok');

  // The Recall key is a frozen constant in the backend — a change needs a
  // restart to take effect. Other keys (AI/Slack/GetOverview) apply live.
  if (recallKeyChanged && patch.RECALL_API_KEY) {
    settingsStatusEl.textContent = 'Saved. Restart the app to start recording.';
    if (window.recall?.restartApp && confirm('Recall API key saved. Restart now to apply it?')) {
      window.recall.restartApp();
    }
  } else {
    settingsStatusEl.textContent = 'Saved.';
  }
});

// ---- Auto-save (debounced) ----

let saveTimer = null;
const flashSaved = () => {
  saveStateEl.textContent = 'Saved';
  saveStateEl.classList.add('is-visible');
  setTimeout(() => saveStateEl.classList.remove('is-visible'), 1500);
};

// Persist a patch for the open note after a 1s pause; updates memory + list.
const scheduleSave = (patch) => {
  if (!currentId) {
    return;
  }
  const id = currentId;
  saveStateEl.textContent = 'Saving…';
  saveStateEl.classList.add('is-visible');

  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const res = await window.recall?.updateMeeting({ id, patch });
    if (res?.ok && res.meeting) {
      const idx = meetings.findIndex((m) => m.id === id);
      if (idx !== -1) {
        meetings[idx] = res.meeting;
      }
      if (patch.title !== undefined) {
        renderMeetingList();
      }
      flashSaved();
    } else {
      saveStateEl.textContent = `Save failed — ${res?.error || 'unknown error'}`;
    }
  }, 1000);
};

editorEl.addEventListener('input', () => scheduleSave({ content: editorEl.value }));
noteTitleEl.addEventListener('input', () => scheduleSave({ title: noteTitleEl.value }));

// ---- Delete ----

const deleteNote = async (id) => {
  const res = await window.recall?.deleteMeeting({ id });
  if (!res?.ok) {
    return;
  }
  // Move it into the in-memory trash so the count updates without a reload.
  const moved = meetings.find((m) => m.id === id);
  if (moved) {
    moved.deletedAt = Date.now();
    trashedMeetings.unshift(moved);
  }
  meetings = meetings.filter((m) => m.id !== id);
  renderTrash();
  if (currentId === id) {
    const next = sortedMeetings()[0];
    if (next) {
      showEditor(next.id);
    } else {
      showEmpty();
    }
  } else {
    renderMeetingList();
  }
};

// ---- Load history on startup ----

const loadMeetings = async () => {
  const data = await window.recall?.listMeetings();
  meetings = Array.isArray(data?.meetings) ? data.meetings : [];
  const newest = sortedMeetings()[0];
  if (newest) {
    showEditor(newest.id);
  } else {
    showEmpty();
  }
};

// Load the trashed meetings (newest-trashed first, already sorted by the store)
// and render the trash section.
const loadTrash = async () => {
  const data = await window.recall?.listTrash();
  trashedMeetings = Array.isArray(data?.meetings) ? data.meetings : [];
  renderTrash();
};

// Expand/collapse the trash section.
trashToggleEl.addEventListener('click', () => {
  trashExpanded = !trashExpanded;
  renderTrash();
});

// Build one <option> with a typed value (`channel:<id>` / `user:<id>`) so the
// send handler knows whether to post to a channel or DM a person.
const slackOption = (kind, id, label) => {
  const opt = document.createElement('option');
  opt.value = `${kind}:${id}`;
  opt.textContent = label;
  return opt.outerHTML;
};

// Build a disabled <optgroup> showing a single status line (error/empty state).
const slackStatusGroup = (label, message) =>
  `<optgroup label="${label}"><option value="" disabled>${message}</option></optgroup>`;

// Populate the Slack dropdown once on startup with two groups: Channels and
// People (DM targets). The selection is a global control (like the Huddle
// button) — not stored per-meeting. A bad token / missing scope / empty list
// degrades to a disabled, readable state per group instead of breaking Send.
const loadSlackTargets = async () => {
  if (!window.recall?.listSlackChannels || !window.recall?.listSlackUsers) {
    return;
  }
  const [chanRes, userRes] = await Promise.all([
    window.recall.listSlackChannels(),
    window.recall.listSlackUsers(),
  ]);

  const groups = [];
  let hasTarget = false;

  // Channels group.
  if (chanRes?.ok && chanRes.channels.length) {
    hasTarget = true;
    const opts = chanRes.channels
      .map((c) => slackOption('channel', c.id, `${c.isPrivate ? '🔒 ' : '#'}${c.name}`))
      .join('');
    groups.push(`<optgroup label="Channels">${opts}</optgroup>`);
  } else if (!chanRes?.ok) {
    groups.push(slackStatusGroup('Channels', chanRes?.error || 'Unavailable'));
  }

  // People group (DM targets).
  if (userRes?.ok && userRes.users.length) {
    hasTarget = true;
    const opts = userRes.users
      .map((u) => slackOption('user', u.id, `@${u.name}`))
      .join('');
    groups.push(`<optgroup label="People">${opts}</optgroup>`);
  } else if (!userRes?.ok) {
    groups.push(slackStatusGroup('People', userRes?.error || 'Unavailable'));
  }

  if (!hasTarget && groups.length === 0) {
    slackChannelEl.innerHTML = '<option value="">No destinations found</option>';
    slackChannelEl.disabled = true;
    return;
  }

  // A placeholder leads so nothing is preselected; real targets follow.
  slackChannelEl.innerHTML = `<option value="">Choose a destination…</option>${groups.join('')}`;
  slackChannelEl.disabled = !hasTarget;
};

// ---- GetOverview (internal PM tool) ----

// Build the full "Speaker: words" transcript text for a meeting, reusing the
// shared segmentParts extraction (kept consistent with server.js/chat.js).
const transcriptText = (meeting) => {
  if (!Array.isArray(meeting?.transcript)) {
    return '';
  }
  return meeting.transcript
    .map((seg) => {
      const { speaker, words } = segmentParts(seg);
      return `${speaker}: ${words}`;
    })
    .join('\n');
};

// Distinct speaker names in a meeting, for the transcript submission's
// `participants` field.
const meetingParticipants = (meeting) => {
  if (!Array.isArray(meeting?.transcript)) {
    return [];
  }
  return [...new Set(meeting.transcript.map((seg) => segmentParts(seg).speaker))];
};

// The currently selected project (or null). The dropdown value is the project id.
const selectedProject = () => goProjects.find((p) => p.id === goProjectEl.value) || null;

// Reflect the selected project on the "Open in GetOverview" link.
const syncGoOpenLink = () => {
  const project = selectedProject();
  if (project && project.url) {
    goOpenLink.hidden = false;
    goOpenLink.href = project.url;
  } else {
    goOpenLink.hidden = true;
    goOpenLink.removeAttribute('href');
  }
};

// Populate the project dropdown, grouped by `status` (the only group-able field
// GetOverview exposes). A global control, like the Slack dropdown — not stored
// per-meeting. Degrades to a disabled, readable state on a bad/unset token.
const loadGetOverviewProjects = async () => {
  if (!window.recall?.listGetOverviewProjects) {
    return;
  }
  goProjectEl.disabled = true;
  goProjectEl.innerHTML = '<option value="">Loading…</option>';

  const res = await window.recall.listGetOverviewProjects();
  if (!res?.ok) {
    goProjects = [];
    goProjectEl.innerHTML = `<option value="">${res?.error || 'GetOverview unavailable'}</option>`;
    syncGoOpenLink();
    return;
  }

  goProjects = res.projects || [];
  if (goProjects.length === 0) {
    goProjectEl.innerHTML = '<option value="">No projects found</option>';
    syncGoOpenLink();
    return;
  }

  // Group projects by status into <optgroup>s.
  const byStatus = new Map();
  for (const p of goProjects) {
    const key = p.status || 'Other';
    if (!byStatus.has(key)) byStatus.set(key, []);
    byStatus.get(key).push(p);
  }
  const groups = [...byStatus.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, projects]) => {
      const opts = projects
        .map((p) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name;
          return opt.outerHTML;
        })
        .join('');
      return `<optgroup label="${status}">${opts}</optgroup>`;
    })
    .join('');

  goProjectEl.innerHTML = `<option value="">Choose a project…</option>${groups}`;
  goProjectEl.disabled = false;
  syncGoOpenLink();
};

goProjectEl.addEventListener('change', syncGoOpenLink);
goRefreshBtn.addEventListener('click', () => loadGetOverviewProjects());

// Submit the summary (edited note) or the full raw transcript to GetOverview.
// `which` is 'summary' | 'transcript'; the sourceId differs so the two don't
// collide on GetOverview's idempotency key. Reuses the busy→done/error UX.
const sendToGetOverview = async (btn, which) => {
  const meeting = findMeeting(currentId);
  if (!meeting || !window.recall?.sendGetOverviewTranscript) {
    return;
  }

  const text = which === 'summary' ? editorEl.value : transcriptText(meeting);
  const idleLabel = which === 'summary' ? 'Send summary' : 'Send full transcript';

  btn.disabled = true;
  btn.classList.remove('is-done', 'is-error');
  btn.textContent = 'Sending…';

  const project = selectedProject();
  const res = await window.recall.sendGetOverviewTranscript({
    projectId: project?.id, // optional; space-wide if none selected
    sourceId: `${meeting.recordingId}-${which}`,
    transcript: text,
    meetingTitle: meeting.title,
    participants: meetingParticipants(meeting),
  });

  if (res?.ok) {
    btn.classList.add('is-done');
    btn.textContent = 'Sent ✓';
    setTimeout(() => {
      btn.classList.remove('is-done');
      btn.disabled = false;
      btn.textContent = idleLabel;
    }, 2500);
  } else {
    btn.classList.add('is-error');
    btn.textContent = `Failed — ${res?.error || 'unknown error'}`;
    btn.disabled = false;
  }
};

goSendSummaryBtn.addEventListener('click', () => sendToGetOverview(goSendSummaryBtn, 'summary'));
goSendTranscriptBtn.addEventListener('click', () => sendToGetOverview(goSendTranscriptBtn, 'transcript'));

// ---- Create tasks from action items ----

// Build one editable task row (title / assignee / due date / remove).
const buildTaskRow = (item = {}) => {
  const row = document.createElement('div');
  row.className = 'go-task-row';

  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'go-row-title';
  title.placeholder = 'Task title';
  title.value = item.title || '';

  const assignee = document.createElement('input');
  assignee.type = 'text';
  assignee.className = 'go-row-assignee';
  assignee.placeholder = 'Assignee (name/email)';
  assignee.value = item.assignee || '';

  const due = document.createElement('input');
  due.type = 'date';
  due.className = 'go-row-due';
  due.value = item.dueDate || '';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'go-row-remove';
  remove.title = 'Remove row';
  remove.textContent = '✕';
  remove.addEventListener('click', () => row.remove());

  row.append(title, assignee, due, remove);
  return row;
};

const renderTaskRows = (items) => {
  goTasksRowsEl.innerHTML = '';
  if (!items.length) {
    goTasksRowsEl.append(buildTaskRow());
    return;
  }
  for (const item of items) {
    goTasksRowsEl.append(buildTaskRow(item));
  }
};

const closeTasksEditor = () => {
  goTasksEl.hidden = true;
  goTasksRowsEl.innerHTML = '';
  goTasksStatusEl.textContent = '';
};

// AI-extract action items, then reveal the editable rows for review/edit.
goCreateTasksBtn.addEventListener('click', async () => {
  const meeting = findMeeting(currentId);
  if (!meeting || !window.recall?.extractActionItems) {
    return;
  }

  goCreateTasksBtn.disabled = true;
  goCreateTasksBtn.textContent = 'Extracting…';

  const res = await window.recall.extractActionItems({
    transcript: meeting.transcript,
    summary: editorEl.value,
  });

  goCreateTasksBtn.disabled = false;
  goCreateTasksBtn.textContent = 'Create tasks from action items';

  const items = res?.ok ? res.items : [];
  renderTaskRows(items);
  goTasksEl.hidden = false;
  goTasksStatusEl.textContent = res?.note
    ? res.note
    : items.length
      ? 'Review and edit, then create. A project must be selected.'
      : 'No action items found — add rows manually if needed.';
});

goAddRowBtn.addEventListener('click', () => goTasksRowsEl.append(buildTaskRow()));
goCancelTasksBtn.addEventListener('click', closeTasksEditor);

// Create one GetOverview task per row into the selected project. Per-row
// success/error is shown on the row; a summary line goes to the status text.
goSubmitTasksBtn.addEventListener('click', async () => {
  if (!window.recall?.createGetOverviewTask) {
    return;
  }
  const project = selectedProject();
  if (!project) {
    goTasksStatusEl.textContent = 'Pick a project first (in the dropdown above).';
    return;
  }

  const rows = [...goTasksRowsEl.querySelectorAll('.go-task-row')];
  goSubmitTasksBtn.disabled = true;
  goAddRowBtn.disabled = true;
  goSubmitTasksBtn.textContent = 'Creating…';

  let created = 0;
  let failed = 0;
  for (const row of rows) {
    // Skip rows already created in a prior submit.
    if (row.classList.contains('is-done')) {
      continue;
    }
    const title = row.querySelector('.go-row-title').value.trim();
    if (!title) {
      continue;
    }
    const assignee = row.querySelector('.go-row-assignee').value.trim();
    const dueDate = row.querySelector('.go-row-due').value; // YYYY-MM-DD or ''

    row.classList.remove('is-error');
    const res = await window.recall.createGetOverviewTask({
      projectId: project.id,
      title,
      assignee,
      dueDate: dueDate || undefined,
    });

    if (res?.ok) {
      created += 1;
      row.classList.add('is-done');
    } else {
      failed += 1;
      row.classList.add('is-error');
      row.title = res?.error || 'Failed to create';
    }
  }

  goSubmitTasksBtn.disabled = false;
  goAddRowBtn.disabled = false;
  goSubmitTasksBtn.textContent = 'Create tasks';
  goTasksStatusEl.textContent =
    `Created ${created} task${created === 1 ? '' : 's'} in ${project.name}` +
    (failed ? ` · ${failed} failed (hover a red row for the reason)` : '') +
    '.';
});

// Live-filter the sidebar list as the user types. Filtering only changes which
// rows are listed; the open note stays open even if it's filtered out.
searchInputEl.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderMeetingList();
});

window.addEventListener('DOMContentLoaded', () => {
  loadMeetings();
  loadTrash();
  loadSlackTargets();
  loadGetOverviewProjects();
  refreshConfiguredState();
  // Show the running app version in the sidebar (also a visible marker that an
  // auto-update applied).
  window.recall?.getAppVersion?.().then((v) => {
    const el = document.getElementById('app-version');
    if (el && v) el.textContent = `v${v}`;
  });
});

// ---- Live events from main ----

window.recall?.onStatus((payload) => {
  // With no Recall key configured, keep the "not configured" nudge rather than
  // letting the idle "Waiting for a meeting…" status mask it. Real recording
  // states (a meeting can't be detected without a key) still come through.
  if (!lastSavedRecallKey && payload.type === 'permissions-granted') {
    updateConfiguredState('');
    return;
  }
  const state = STATUS_STATES[payload.type] || { text: payload.type, cls: 'is-waiting' };
  const text = payload.type === 'error' ? `${state.text}: ${payload.message}` : state.text;
  setStatus(text, state.cls);
});

// A completed recording arrives as a fully-formed (already persisted) meeting.
window.recall?.onRecordingComplete((meeting) => {
  setStatus('Transcript ready', 'is-ready');
  // A finished recording (auto or manual) means no huddle is in progress.
  setHuddleState(false);
  const idx = meetings.findIndex((m) => m.id === meeting.id);
  if (idx === -1) {
    meetings.push(meeting);
  } else {
    meetings[idx] = meeting;
  }
  showEditor(meeting.id);
});

// ---- Action buttons (operate on the open note) ----

slackBtn.addEventListener('click', async () => {
  const meeting = findMeeting(currentId);
  if (!meeting || !window.recall?.sendToSlack) {
    return;
  }

  // Selected value is typed: `channel:<id>` or `user:<id>` (a DM target).
  const [kind, id] = slackChannelEl.value.split(':');
  if (!id) {
    slackBtn.classList.add('is-error');
    slackBtnText.textContent = 'Pick a destination';
    setTimeout(() => {
      slackBtn.classList.remove('is-error');
      slackBtnText.textContent = 'Send';
    }, 2000);
    return;
  }

  slackBtn.disabled = true;
  slackBtn.classList.remove('is-sent', 'is-error');
  slackBtnText.textContent = 'Sending…';

  // Send the edited note text (meeting.content), not the original AI summary.
  const res = await window.recall.sendToSlack({
    recordingId: meeting.recordingId,
    summary: editorEl.value,
    videoUrl: meeting.videoUrl,
    time: fullDate(meeting.date),
    channel: id,
    isDm: kind === 'user',
  });

  if (res?.ok) {
    slackBtn.classList.add('is-sent');
    slackBtnText.textContent = 'Sent ✓';
    setTimeout(() => {
      slackBtn.classList.remove('is-sent');
      slackBtn.disabled = false;
      slackBtnText.textContent = 'Send';
    }, 2500);
  } else {
    slackBtn.classList.add('is-error');
    slackBtnText.textContent = `Failed — ${res?.error || 'unknown error'}`;
    slackBtn.disabled = false;
  }
});

// Drives a save button through busy → done/canceled/error states.
const runSave = async (btn, idleLabel, busyLabel, doneLabel, action) => {
  const meeting = findMeeting(currentId);
  if (!meeting) {
    return;
  }
  btn.disabled = true;
  btn.classList.remove('is-done', 'is-error');
  setActionLabel(btn, busyLabel);

  const res = await action(meeting);

  if (res?.ok) {
    btn.classList.add('is-done');
    setActionLabel(btn, doneLabel);
    if (res.path) {
      savedPathEl.hidden = false;
      savedPathEl.textContent = `Saved to ${res.path}`;
    }
    setTimeout(() => {
      btn.classList.remove('is-done');
      btn.disabled = false;
      setActionLabel(btn, idleLabel);
    }, 2500);
  } else if (res?.canceled) {
    btn.disabled = false;
    setActionLabel(btn, idleLabel);
  } else {
    btn.classList.add('is-error');
    setActionLabel(btn, `Failed — ${res?.error || 'unknown error'}`);
    btn.disabled = false;
  }
};

saveTranscriptBtn.addEventListener('click', () =>
  runSave(saveTranscriptBtn, 'Transcript', 'Saving…', 'Saved ✓', (meeting) =>
    window.recall.saveTranscript({
      recordingId: meeting.recordingId,
      transcript: meeting.transcript,
    }),
  ),
);

saveRecordingBtn.addEventListener('click', () =>
  runSave(saveRecordingBtn, 'Download', 'Saving…', 'Saved ✓', (meeting) =>
    window.recall.saveRecording({
      recordingId: meeting.recordingId,
      videoUrl: meeting.videoUrl,
    }),
  ),
);
