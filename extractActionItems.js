/**
 * AI extraction of structured action items from a meeting, via the same
 * OpenAI-compatible chat-completions API (requesty.ai) used by summarize.js and
 * chat.js. Given the transcript (and the already-generated summary for extra
 * context), returns an array of { title, assignee, dueDate } objects to pre-fill
 * the "Create tasks in GetOverview" editor, which the user then edits.
 *
 * This is a sibling module to summarize.js (left untouched) — the same pattern
 * chat.js follows — so the summary path is unaffected.
 *
 * `extractActionItems` never throws — on any failure it returns
 * { items: [], error } so the UI can show an empty editable list with a note.
 */

const BASE_URL = 'https://router.requesty.ai/v1';
const MODEL = 'google/gemma-4-31b-it';

// Today's date is injected so the model can resolve relative dates ("next
// Friday", "by end of week") into concrete ISO dates.
const SYSTEM_PROMPT =
  'You extract action items from a meeting transcript and summary. ' +
  'Respond with ONLY a JSON array (no prose, no markdown fences). Each element ' +
  'is an object with exactly these keys:\n' +
  '  "title": a concise imperative task title (string),\n' +
  '  "assignee": the responsible person\'s name or email if stated, else "Assignee Not Mentioned" (string),\n' +
  '  "dueDate": an ISO 8601 date (YYYY-MM-DD) if a deadline is stated or can be ' +
  'resolved from a relative date, else "Due Date Not Mentioned" (string).\n' +
  'Only include real, actionable items. If there are none, respond with [].';

// Mirror summarize.js's normalizeSegment / chat.js's segmentToLine so the
// transcript is rendered identically across the app.
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

// Pull a JSON array out of a model response that may be wrapped in prose or
// ```json fences. Returns [] on any parse failure.
function parseItems(content) {
  if (typeof content !== 'string') {
    return [];
  }
  let text = content.trim();
  // Strip a leading/trailing markdown code fence if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    text = fence[1].trim();
  }
  // Otherwise, isolate the first [...] block.
  if (!text.startsWith('[')) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((it) => ({
        title: typeof it.title === 'string' ? it.title.trim() : '',
        assignee: typeof it.assignee === 'string' ? it.assignee.trim() : '',
        dueDate: typeof it.dueDate === 'string' ? it.dueDate.trim() : '',
      }))
      .filter((it) => it.title);
  } catch {
    return [];
  }
}

/**
 * Extract structured action items from a meeting.
 *
 * @param {Array} transcript Recall transcript segments (native shape accepted).
 * @param {string} [summary] The already-generated Markdown summary, for context.
 * @returns {Promise<{ items: Array<{title:string,assignee:string,dueDate:string}>, error?: string }>}
 *   Never throws.
 */
async function extractActionItems(transcript, summary = '') {
  const apiKey = process.env.REQUESTY_API_KEY || process.env.RECALLAI_REQUEST_KEY;
  if (!apiKey) {
    return { items: [], error: 'AI unavailable — REQUESTY_API_KEY is not set in .env' };
  }
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return { items: [], error: 'No transcript was captured for this meeting.' };
  }

  const today = new Date().toISOString().slice(0, 10);
  const userMessage =
    `Today's date is ${today}.\n\n` +
    (summary && String(summary).trim() ? `Summary:\n${summary}\n\n` : '') +
    `Transcript:\n${renderTranscript(transcript)}`;

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('extractActionItems failed:', response.status, detail.slice(0, 300));
      return { items: [], error: `AI unavailable — requesty.ai returned ${response.status}` };
    }

    const json = await response.json();
    const content = json.choices?.[0]?.message?.content;
    return { items: parseItems(content) };
  } catch (err) {
    console.error('extractActionItems error:', err);
    return { items: [], error: `AI unavailable — ${String(err)}` };
  }
}

module.exports = { extractActionItems };
