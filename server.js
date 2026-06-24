require('dotenv').config();
const express = require('express');
const { summarizeTranscript } = require('./summarize');
const { answerQuestion } = require('./chat');
const { extractActionItems: extractActionItemsImpl } = require('./extractActionItems');
const app = express();
app.use(express.json());

const RECALL_API_KEY = process.env.RECALL_API_KEY;
const RECALL_API_URL = process.env.RECALL_API_URL || 'https://us-west-2.recall.ai';
// Slack Web API bot token (replaces the old Incoming Webhook, which was locked
// to a single channel). The user stored it in .env under `Bot_User_OAuth_Token`;
// accept a couple of name variants. If unset, "Send to Slack" reports it.
const SLACK_BOT_TOKEN =
  process.env.Bot_User_OAuth_Token ||
  process.env.SLACK_BOT_TOKEN ||
  process.env.SLACK_BOT_USER_OAUTH_TOKEN;
// GetOverview (internal PM tool) — optional. The base URL and Personal Access
// Token live in .env under these exact names. If unset, the GetOverview helpers
// below report "not configured" instead of failing (like Slack).
const GETOVERVIEW_BASE_URL = (process.env.GetOverview_BASE_URL || '').replace(/\/+$/, '');
const GETOVERVIEW_TOKEN = process.env.GetOverview_Access_Token;
// Optional at startup: the AI summary degrades to a readable error string if
// REQUESTY_API_KEY is missing (see summarize.js), so we don't exit on it.
if (!process.env.REQUESTY_API_KEY && !process.env.RECALLAI_REQUEST_KEY) {
  console.warn('REQUESTY_API_KEY not set — AI summaries will be unavailable.');
}

if (!RECALL_API_KEY) {
  console.error('Missing RECALL_API_KEY. Create a .env file with RECALL_API_KEY=your_key');
  process.exit(1);
}

// Recall expects the Authorization header in the form "Token <api_key>".
const authHeaders = {
  accept: 'application/json',
  'content-type': 'application/json',
  Authorization: `Token ${RECALL_API_KEY}`,
};

app.post('/api/create_sdk_recording', async (req, res) => {
  try {
    // This calls Recall.ai on behalf of your Electron app. The recording_config
    // is what requests a transcript: without it Recall uploads the media but
    // never generates one, so media_shortcuts.transcript stays absent. We use
    // recallai_streaming (Recall's own transcription — no third-party key).
    const response = await fetch(`${RECALL_API_URL}/api/v1/sdk_upload/`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        recording_config: {
          video_mixed_mp4: {},
          transcript: {
            provider: { recallai_streaming: {} },
          },
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('create_sdk_recording failed:', response.status, text);
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();

    // Sends the upload token back to your Electron app
    res.json(data);
  } catch (err) {
    console.error('create_sdk_recording error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Tracks recordings already processed (keyed by the resolved Recall recording
// id), so a re-triggered poll for the same recording is ignored.
const handledRecordings = new Set();

// Server-free completion path. Instead of an inbound Recall webhook, the Electron
// main process calls this when the SDK fires `recording-ended`, passing the
// desktop_sdk_upload id captured at record-start. We then POLL the Recall API
// (outbound only — no public endpoint needed) until the recording's media is
// ready, download the transcript, summarize, and notify main via the registered
// handler — the same downstream flow the old webhook used.
//
// Media lags `recording-ended` by minutes (the recording uploads/processes
// server-side after the call ends), so the poll runs much longer than the old
// few-seconds webhook poll, with capped backoff.
async function processCompletedUpload(uploadId) {
  if (!uploadId) {
    console.error('processCompletedUpload called without an uploadId');
    return;
  }

  try {
    console.log('Polling for completed recording, upload id:', uploadId);

    // ~20 attempts, backoff 3s → capped at 15s (≈3.5 min total). Poll until both
    // the transcript and the mixed video download URLs are present (or timeout,
    // in which case we forward whatever we have — as the old handler did).
    const MAX_ATTEMPTS = 20;
    let recording = null;
    let transcriptUrl;
    let videoUrl;
    let recordingId;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      recording = await fetchRecordingByUploadId(uploadId);
      if (recording) {
        recordingId = recording.id;
        transcriptUrl = recording.media_shortcuts?.transcript?.data?.download_url;
        videoUrl = recording.media_shortcuts?.video_mixed?.data?.download_url;

        // Dedup as soon as we know the recording id: a second `recording-ended`
        // trigger (or a stray re-poll) for the same recording is a no-op.
        if (recordingId && handledRecordings.has(recordingId)) {
          console.log('Already handled recording, skipping duplicate:', recordingId);
          return;
        }

        if (transcriptUrl && videoUrl) {
          break;
        }
      }
      console.log(`Recording media not ready yet (attempt ${attempt}/${MAX_ATTEMPTS})…`);
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(3000 * attempt, 15000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (!recording) {
      console.error('Recording never became available for upload id:', uploadId);
      return;
    }

    if (recordingId) {
      handledRecordings.add(recordingId);
    }

    if (!transcriptUrl) {
      console.error(`Transcript not ready after ${MAX_ATTEMPTS} attempts.`);
    }

    console.log('Recording ready! ID:', recordingId);
    console.log('Video download URL:', videoUrl);
    console.log('Transcript download URL:', transcriptUrl);

    let transcript = null;
    if (transcriptUrl) {
      const transcriptRes = await fetch(transcriptUrl);
      if (transcriptRes.ok) {
        transcript = await transcriptRes.json();
        console.log('Transcript downloaded:', JSON.stringify(transcript).slice(0, 500));
      } else {
        console.error('transcript download failed:', transcriptRes.status);
      }
    }

    // Generate the AI summary that the UI displays in place of the raw
    // transcript. Streaming is used internally (the spec's progressCallback),
    // but we await the final string here. summarizeTranscript never throws —
    // it returns a readable error string on failure, which the UI shows as-is.
    let summary = null;
    if (transcript) {
      summary = await summarizeTranscript(transcript, [], {
        stream: true,
        progressCallback: (text) => {
          // Coarse progress signal in the backend log; the UI renders once.
          process.stdout.write(`\rSummarizing… ${text.length} chars`);
        },
      });
      process.stdout.write('\n');
      console.log('Summary generated:', String(summary).slice(0, 200));
    }

    // Notify the Electron main process (which require()s this module and
    // registers a handler via setRecordingCompleteHandler) so it can forward
    // the result to the renderer UI. Saving to disk is manual (the renderer's
    // "Save transcript as…" / "Save recording" buttons) — nothing is written
    // automatically.
    if (onRecordingComplete) {
      onRecordingComplete({ recordingId, videoUrl, transcriptUrl, transcript, summary });
    }
  } catch (err) {
    console.error('processCompletedUpload error:', err);
  }
}

// Render a Recall transcript payload as readable "Speaker: words" lines. Mirrors
// the renderer's formatTranscript (renderer.js); kept in sync by hand since the
// renderer can't import from the main process.
function formatTranscript(transcript) {
  if (!Array.isArray(transcript)) {
    return JSON.stringify(transcript, null, 2);
  }
  return transcript
    .map((segment) => {
      const speaker = segment.speaker || segment.participant?.name || 'Speaker';
      const words = Array.isArray(segment.words)
        ? segment.words.map((w) => w.text).join(' ')
        : segment.text || '';
      return `${speaker}: ${words}`;
    })
    .join('\n');
}

// Slack Web API helpers. Note: the Web API returns HTTP 200 with a JSON body of
// `{ ok: false, error }` on logical failures (bad token, not_in_channel, …), so
// callers must check the parsed `ok` field, not just `res.ok`.
const slackHeaders = () => ({
  'content-type': 'application/json; charset=utf-8',
  authorization: `Bearer ${SLACK_BOT_TOKEN}`,
});

async function slackApi(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: slackHeaders(),
    body: JSON.stringify(payload),
  });
  return res.json();
}

const postMessage = (channel, text) => slackApi('chat.postMessage', { channel, text });
const joinChannel = (channel) => slackApi('conversations.join', { channel });
const openDm = (user) => slackApi('conversations.open', { users: user });

// List the workspace's public + private channels the bot can see, for the
// renderer's channel dropdown. Paginates via response_metadata.next_cursor.
// Returns { ok: true, channels: [{ id, name, isPrivate }] } sorted by name, or
// { ok: false, error }. Never throws.
async function listSlackChannels() {
  if (!SLACK_BOT_TOKEN) {
    return { ok: false, error: 'Slack bot token not configured (set Bot_User_OAuth_Token in .env)' };
  }

  try {
    const channels = [];
    let cursor = '';
    do {
      const params = new URLSearchParams({
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '1000',
      });
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
        headers: slackHeaders(),
      });
      const data = await res.json();
      if (!data.ok) {
        console.error('Slack conversations.list failed:', data.error);
        return { ok: false, error: `Slack: ${data.error}` };
      }

      for (const c of data.channels || []) {
        channels.push({ id: c.id, name: c.name, isPrivate: !!c.is_private });
      }
      cursor = data.response_metadata?.next_cursor || '';
    } while (cursor);

    channels.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, channels };
  } catch (err) {
    console.error('Slack listChannels error:', err);
    return { ok: false, error: String(err) };
  }
}

// List the workspace's real human members, for the renderer's "People" group
// (so a summary can be DM'd to a person instead of posted to a channel). Skips
// bots, apps, deactivated accounts, and Slackbot. Paginates via next_cursor.
// Returns { ok: true, users: [{ id, name }] } sorted by name, or { ok:false, error }.
// Never throws.
async function listSlackUsers() {
  if (!SLACK_BOT_TOKEN) {
    return { ok: false, error: 'Slack bot token not configured (set Bot_User_OAuth_Token in .env)' };
  }

  try {
    const users = [];
    let cursor = '';
    do {
      const params = new URLSearchParams({ limit: '1000' });
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(`https://slack.com/api/users.list?${params}`, {
        headers: slackHeaders(),
      });
      const data = await res.json();
      if (!data.ok) {
        console.error('Slack users.list failed:', data.error);
        return { ok: false, error: `Slack: ${data.error}` };
      }

      for (const m of data.members || []) {
        if (m.deleted || m.is_bot || m.is_app_user || m.id === 'USLACKBOT') continue;
        const p = m.profile || {};
        const name = p.display_name || p.real_name || m.name;
        users.push({ id: m.id, name });
      }
      cursor = data.response_metadata?.next_cursor || '';
    } while (cursor);

    users.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, users };
  } catch (err) {
    console.error('Slack listUsers error:', err);
    return { ok: false, error: String(err) };
  }
}

// Post the AI summary to a Slack channel or DM via the Web API. `channel` is a
// channel id, or — when `isDm` is set — a user id (we open the DM first).
// Returns { ok: true } on success, or { ok: false, error } if unconfigured/failed.
async function sendToSlack({ recordingId, summary, videoUrl, time, channel, isDm }) {
  if (!SLACK_BOT_TOKEN) {
    return { ok: false, error: 'Slack bot token not configured (set Bot_User_OAuth_Token in .env)' };
  }
  if (!channel) {
    return { ok: false, error: 'No Slack destination selected' };
  }

  try {
    const header = `*Meeting summary* · ${time || 'recording'} · \`${recordingId}\``;
    const videoLine = videoUrl ? `\n<${videoUrl}|Video recording>` : '';

    // Keep the message comfortably under Slack's limit and readable.
    const MAX_BODY = 3500;
    let body = (typeof summary === 'string' && summary.trim()) || 'No summary available.';
    if (body.length > MAX_BODY) {
      body = `${body.slice(0, MAX_BODY)}\n…(truncated)`;
    }

    const text = `${header}${videoLine}\n\n${body}`;

    // For a DM, resolve the user id to its DM channel id first.
    let target = channel;
    if (isDm) {
      const dm = await openDm(channel);
      if (!dm.ok) {
        console.error('Slack open DM failed:', dm.error);
        return { ok: false, error: `Slack: ${dm.error}` };
      }
      target = dm.channel.id;
    }

    let data = await postMessage(target, text);
    // Auto-join public channels the bot isn't a member of yet, then retry once.
    // (DMs and private channels can't be self-joined — only public channels.)
    if (!isDm && !data.ok && data.error === 'not_in_channel') {
      const joined = await joinChannel(target);
      if (joined.ok) data = await postMessage(target, text);
    }

    if (!data.ok) {
      console.error('Slack send failed:', data.error);
      return { ok: false, error: `Slack: ${data.error}` };
    }

    console.log('Sent transcript to Slack:', recordingId, '→', isDm ? `DM ${channel}` : channel);
    return { ok: true };
  } catch (err) {
    console.error('Slack send error:', err);
    return { ok: false, error: String(err) };
  }
}

// ---- GetOverview (internal PM tool) Web API helpers ----
//
// Mirror the Slack helpers: all are token-guarded, never throw, and return
// { ok, ... } | { ok:false, error } — surfacing GetOverview's logical errors
// verbatim. Auth is a Bearer token; the base URL comes from .env.

const getoverviewHeaders = () => ({
  accept: 'application/json',
  'content-type': 'application/json',
  authorization: `Bearer ${GETOVERVIEW_TOKEN}`,
});

// Generic request wrapper. Returns { ok:true, data } on a 2xx (data is the
// parsed JSON body, or null on 204/empty), or { ok:false, error } otherwise.
// Never throws.
async function getoverviewApi(method, pathname, body) {
  if (!GETOVERVIEW_BASE_URL || !GETOVERVIEW_TOKEN) {
    return {
      ok: false,
      error: 'GetOverview not configured (set GetOverview_BASE_URL and GetOverview_Access_Token in .env)',
    };
  }
  try {
    const res = await fetch(`${GETOVERVIEW_BASE_URL}${pathname}`, {
      method,
      headers: getoverviewHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // GetOverview returns JSON on both success and error; tolerate empty bodies.
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const detail = data && data.message ? data.message : (typeof data === 'string' ? data : res.statusText);
      console.error('GetOverview API failed:', method, pathname, res.status, detail);
      return { ok: false, error: `GetOverview: ${detail || res.status}` };
    }
    return { ok: true, data };
  } catch (err) {
    console.error('GetOverview API error:', method, pathname, err);
    return { ok: false, error: String(err) };
  }
}

// List the projects the token can see, for the renderer's project dropdown.
// Returns { ok:true, projects:[{ id, name, status, url }] } sorted by name, or
// { ok:false, error }. The renderer groups the dropdown by `status` (the only
// group-able field GetOverview exposes on a project). Never throws.
async function listGetOverviewProjects() {
  const res = await getoverviewApi('GET', '/api/v1/projects');
  if (!res.ok) {
    return res;
  }
  // The endpoint returns an array of projects (tolerate a { projects: [...] } wrap).
  const raw = Array.isArray(res.data) ? res.data : (res.data?.projects || []);
  const projects = raw.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status || 'Other',
    url: p.url || '',
  }));
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, projects };
}

// Create a task in a project from a (refined) action item. `dueDate` is an ISO
// 8601 string or unix ms; empty optional fields are omitted. Returns
// { ok:true, task } (task includes a `url`) or { ok:false, error }. Never throws.
async function createGetOverviewTask({ projectId, title, assignee, dueDate, description }) {
  if (!projectId) {
    return { ok: false, error: 'No GetOverview project selected' };
  }
  if (!title || !String(title).trim()) {
    return { ok: false, error: 'Task title is required' };
  }
  const body = { title: String(title).trim() };
  if (assignee && String(assignee).trim()) body.assignee = String(assignee).trim();
  if (dueDate) body.dueDate = dueDate;
  if (description && String(description).trim()) body.description = String(description).trim();

  const res = await getoverviewApi('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, body);
  if (!res.ok) {
    return res;
  }
  return { ok: true, task: res.data };
}

// Submit a transcript/summary to GetOverview, which processes it server-side
// into its own summary/action items/status. `transcript` carries whichever text
// the caller chose (the edited summary, or the full raw transcript). `sourceId`
// is the idempotency key — callers use distinct ids for the summary vs the full
// transcript so the two submissions don't collide. When `projectId` is set, the
// project-scoped endpoint is used. Returns { ok:true, jobId, status } (202) or
// { ok:false, error }. We don't poll the result back (GetOverview keeps it).
// Never throws.
async function sendTranscriptToGetOverview({ projectId, sourceId, transcript, meetingTitle, participants }) {
  if (!sourceId) {
    return { ok: false, error: 'Missing sourceId for GetOverview submission' };
  }
  if (!transcript || !String(transcript).trim()) {
    return { ok: false, error: 'Nothing to submit — the text is empty' };
  }
  const MAX_BYTES = 700000;
  let text = String(transcript);
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    // Trim from the end until it fits (rare; very long meetings only).
    text = Buffer.from(text, 'utf8').subarray(0, MAX_BYTES).toString('utf8');
  }

  const body = { sourceId, transcript: text };
  if (meetingTitle) body.meetingTitle = meetingTitle;
  if (Array.isArray(participants) && participants.length) body.participants = participants;

  const pathname = projectId
    ? `/api/v1/projects/${encodeURIComponent(projectId)}/transcripts`
    : '/api/v1/transcripts';
  const res = await getoverviewApi('POST', pathname, body);
  if (!res.ok) {
    return res;
  }
  return { ok: true, jobId: res.data?.jobId, status: res.data?.status };
}

// Look up a recording by its desktop_sdk_upload id (the `id` returned from
// /api/v1/sdk_upload/ at record-start). The list endpoint filters by
// `desktop_sdk_upload_id` and returns at most one match (uploads are unique).
// Returns the recording object or null.
async function fetchRecordingByUploadId(uploadId) {
  const r = await fetch(
    `${RECALL_API_URL}/api/v1/recording/?desktop_sdk_upload_id=${uploadId}`,
    { headers: authHeaders },
  );
  if (!r.ok) {
    console.error('fetch recording by upload id failed:', r.status, await r.text());
    return null;
  }
  const data = await r.json();
  return data.results?.[0] || null;
}

// The Electron main process registers an in-process listener here to receive
// completed-recording notifications (set by main.js).
let onRecordingComplete = null;
function setRecordingCompleteHandler(fn) {
  onRecordingComplete = fn;
}

function start(port = 3100) {
  return new Promise((resolve) => {
    const server = app.listen(port);

    server.once('listening', () => {
      console.log(`Backend running on http://localhost:${port}`);
      resolve(server);
    });

    // Never let a listen failure crash the host process (e.g. the Electron
    // main process). On a port clash we assume an existing backend is already
    // serving these endpoints and carry on.
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `Port ${port} already in use — another instance or a stale process is running. ` +
            'Reusing the existing backend; not starting a second one.',
        );
      } else {
        console.error('Backend failed to start:', err);
      }
      resolve(null);
    });
  });
}

// Answer a chat question about a meeting, grounded in its transcript. Wraps
// chat.js's answerQuestion (which never throws) into the { ok, ... } shape the
// renderer's IPC actions use.
async function askMeeting({ transcript, question, history }) {
  const answer = await answerQuestion(transcript, question, history);
  return { ok: true, answer };
}

// Extract structured action items ({ title, assignee, dueDate }) from a meeting,
// for pre-filling the "Create tasks in GetOverview" editor. Wraps the never-throw
// extractActionItems module into the { ok, ... } shape the renderer IPC uses.
async function extractActionItems({ transcript, summary }) {
  const result = await extractActionItemsImpl(transcript, summary);
  // The module returns { items, error? }; surface a soft error but still ok so
  // the renderer can show the (possibly empty) list with a note.
  return { ok: true, items: result.items || [], note: result.error };
}

// Support both `node server.js` (standalone) and require() from main.js.
if (require.main === module) {
  start();
}

module.exports = { app, start, setRecordingCompleteHandler, processCompletedUpload, sendToSlack, listSlackChannels, listSlackUsers, formatTranscript, askMeeting, listGetOverviewProjects, createGetOverviewTask, sendTranscriptToGetOverview, extractActionItems };
