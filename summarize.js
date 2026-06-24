/**
 * AI meeting summarization via an OpenAI-compatible chat-completions API
 * (requesty.ai). Given a transcript, produces a structured Markdown summary
 * with three fixed sections: Participants, Summary, Action Items.
 *
 * `summarizeTranscript` never throws — on any failure (missing key, non-OK
 * response, parse/network error) it returns a human-readable error string so
 * the UI can display it as-is.
 */

const BASE_URL = 'https://router.requesty.ai/v1';
// Swap in any OpenAI-compatible model the router exposes.
const MODEL = 'google/gemma-4-31b-it';

const SYSTEM_PROMPT =
  "You are an AI assistant that summarizes meeting transcripts. " +
      "You MUST format your response using the following structure:\n\n" +
      "# Participants\n" +
      "- [List all participants mentioned in the transcript]\n\n" +
      "# Summary\n" +
      "- [Key discussion point 1]\n" +
      "- [Key discussion point 2]\n" +
      "- [Key decisions made]\n" +
      "- [Include any important deadlines or dates mentioned]\n\n" +
      "# Action Items\n" +
      "- [Action item 1] - [Responsible person and Due Date if mentioned]\n" +
      "- [Action item 2] - [Responsible person and Due Date if mentioned]\n" +
      "- [Add any other action items discussed]\n\n" +
      "Stick strictly to this format with these exact section headers. Keep each bullet point concise but informative.";

// Recall's native transcript segment shape is { speaker | participant.name,
// words: [{ text, start_timestamp }], ... }. The documented input shape is
// { speaker, text, timestamp }. Normalize both into { speaker, text, timestamp }.
// (Mirrors the speaker/words extraction in server.js's formatTranscript.)
function normalizeSegment(segment) {
  const speaker = segment.speaker || segment.participant?.name || 'Speaker';
  const text = Array.isArray(segment.words)
    ? segment.words.map((w) => w.text).join(' ')
    : segment.text || '';
  const timestamp =
    segment.timestamp ||
    segment.words?.[0]?.start_timestamp?.absolute ||
    '';
  return { speaker, text, timestamp };
}

// Build the user message: a participant roster followed by the transcript
// rendered as "Speaker: text" lines. When no participant list is provided,
// derive the roster from the distinct speakers in the transcript.
function buildUserMessage(segments, participants) {
  let roster;
  if (Array.isArray(participants) && participants.length > 0) {
    roster = participants
      .map((p) => (p.isHost ? `${p.name} (host)` : p.name))
      .join(', ');
  } else {
    roster = [...new Set(segments.map((s) => s.speaker))].join(', ');
  }

  const body = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');

  return (
    `Participants: ${roster || 'unknown'}\n\n` +
    `Transcript:\n${body}`
  );
}

// Stream an SSE chat-completions response: accumulate delta.content, invoking
// progressCallback(accumulatedText) on each chunk. Returns the full text.
async function readStream(response, progressCallback) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';

  // SSE frames are separated by blank lines; a frame may span reads, so we
  // keep a buffer and only consume complete lines.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line.startsWith('data:')) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        return accumulated;
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          accumulated += delta;
          if (typeof progressCallback === 'function') {
            progressCallback(accumulated);
          }
        }
      } catch {
        // Ignore keep-alive comments or partial/non-JSON data lines.
      }
    }
  }

  return accumulated;
}

/**
 * Summarize a meeting transcript.
 *
 * @param {Array<{speaker:string,text:string,timestamp:string}>} transcript
 *   Transcript segments. Recall's native segment shape is also accepted.
 * @param {Array<{name:string,isHost:boolean}>} [participants] Optional roster;
 *   when empty, the roster is derived from transcript speakers.
 * @param {{stream?:boolean, progressCallback?:(currentText:string)=>void}} [options]
 *   `stream` (default true) enables token streaming; `progressCallback` fires
 *   with the accumulated text on every chunk while streaming.
 * @returns {Promise<string>} The Markdown summary, or a human-readable error
 *   string on failure (never throws).
 */
async function summarizeTranscript(transcript, participants = [], options = {}) {
  const { stream = true, progressCallback } = options;

  // Prefer the documented REQUESTY_API_KEY; fall back to RECALLAI_REQUEST_KEY,
  // the name the requesty.ai key is stored under in this project's .env.
  const apiKey = process.env.REQUESTY_API_KEY || process.env.RECALLAI_REQUEST_KEY;
  if (!apiKey) {
    return 'Summary unavailable — REQUESTY_API_KEY is not set in .env';
  }

  if (!Array.isArray(transcript) || transcript.length === 0) {
    return 'Summary unavailable — no transcript was captured for this meeting.';
  }

  const segments = transcript.map(normalizeSegment);
  const userMessage = buildUserMessage(segments, participants);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        stream,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('summarize failed:', response.status, detail.slice(0, 300));
      return `Summary unavailable — requesty.ai returned ${response.status}`;
    }

    if (stream) {
      const text = await readStream(response, progressCallback);
      return text.trim() || 'Summary unavailable — the model returned no content.';
    }

    const json = await response.json();
    const content = json.choices?.[0]?.message?.content;
    return (content || '').trim() || 'Summary unavailable — the model returned no content.';
  } catch (err) {
    console.error('summarize error:', err);
    return `Summary unavailable — ${String(err)}`;
  }
}

module.exports = { summarizeTranscript };
