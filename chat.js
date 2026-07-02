/**
 * AI chat over a meeting transcript, via the same OpenAI-compatible
 * chat-completions API (requesty.ai) used by summarize.js. Answers a user's
 * question grounded ONLY in the provided transcript, optionally continuing a
 * prior Q&A thread.
 *
 * `answerQuestion` never throws — on any failure it returns a human-readable
 * error string so the UI can show it as an answer bubble.
 */

const BASE_URL = 'https://router.requesty.ai/v1';
const MODEL = 'google/gemma-4-31b-it';

const SYSTEM_PROMPT =
  'You are an AI assistant that answers questions about a single meeting, ' +
  'using ONLY the transcript provided. Base every answer strictly on the ' +
  'transcript — do not invent facts. If the answer is not in the transcript, ' +
  'say you could not find it in the meeting. Keep answers concise and direct, ' +
  'and quote or name speakers when relevant.';

// Mirror summarize.js's normalizeSegment / formatTranscript so the transcript
// is rendered identically across the app.
function segmentToLine(segment) {
  const speaker = segment.speaker || segment.participant?.name || 'Speaker';
  const text = Array.isArray(segment.words)
    ? segment.words.map((w) => w.text).join(' ')
    : segment.text || '';
  return `${speaker}: ${text}`;
}

function renderTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return '(no transcript was captured for this meeting)';
  }
  return transcript.map(segmentToLine).join('\n');
}

// Stream an SSE chat-completions response: accumulate delta.content, invoking
// progressCallback(accumulatedText) on each chunk. Returns the full text.
// Mirrors summarize.js's readStream (kept separate to preserve module
// independence).
async function readStream(response, progressCallback) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';

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

// Keep only well-formed prior turns, so a malformed persisted thread can't
// break the request.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string',
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Answer a question about a meeting.
 *
 * @param {Array} transcript Recall transcript segments (native shape accepted).
 * @param {string} question The user's question.
 * @param {Array<{role:'user'|'assistant',content:string}>} [history] Prior turns.
 * @param {{stream?:boolean, progressCallback?:(text:string)=>void}} [opts]
 * @returns {Promise<string>} The answer, or a human-readable error string.
 */
async function answerQuestion(transcript, question, history = [], opts = {}) {
  const { stream = false, progressCallback } = opts;
  const apiKey = process.env.REQUESTY_API_KEY || process.env.RECALLAI_REQUEST_KEY;
  if (!apiKey) {
    return 'Chat unavailable — REQUESTY_API_KEY is not set in .env';
  }
  if (typeof question !== 'string' || !question.trim()) {
    return 'Please enter a question.';
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Meeting transcript:\n${renderTranscript(transcript)}` },
    ...sanitizeHistory(history),
    { role: 'user', content: question },
  ];

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, stream, messages }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('chat failed:', response.status, detail.slice(0, 300));
      return `Chat unavailable — requesty.ai returned ${response.status}`;
    }

    if (stream) {
      const text = await readStream(response, progressCallback);
      return text.trim() || 'Chat unavailable — the model returned no content.';
    }

    const json = await response.json();
    const content = json.choices?.[0]?.message?.content;
    return (content || '').trim() || 'Chat unavailable — the model returned no content.';
  } catch (err) {
    console.error('chat error:', err);
    return `Chat unavailable — ${String(err)}`;
  }
}

module.exports = { answerQuestion };
