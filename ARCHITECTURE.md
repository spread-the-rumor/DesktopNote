# Your Call AI — Architecture & Replication Guide

A complete, step-by-step guide so any team member can rebuild and run this app from scratch.

This is an **Electron desktop app** that uses the **Recall.ai Desktop SDK** to:

1. Detect a meeting (Google Meet in Chrome/Edge on Windows),
2. Record it automatically,
3. Receive a transcript back from Recall via a webhook,
4. Save the transcript to disk and show it in the app's UI.

---

## 1. The big picture

Three processes cooperate, and data flows in a **loop**:

```
                 (1) meeting-detected
   Recall SDK  ───────────────────────►  main.js (Electron main)
 (native agent)                                │
        ▲                                      │ (2) POST /api/create_sdk_recording
        │ (3) startRecording(uploadToken)      ▼
        │                              server.js (Express backend, in-process)
        │                                      │
        │                                      │ (2a) POST Recall API → upload_token
        │ ◄────────────────────────────────────┘
        │
        │  ... meeting happens, you talk ...
        │
        │ (4) Recall finishes processing, sends webhook
        ▼
   Recall cloud  ──── POST /webhook ────►  server.js
                                                │ (5) fetch recording + download transcript
                                                │     save to recordings/ on disk
                                                ▼
                                          main.js (setRecordingCompleteHandler)
                                                │ (6) IPC: 'recording-complete'
                                                ▼
                                          renderer.js (UI) renders transcript
```

In one sentence: **renderer ← main ← in-process backend ← Recall**.

### The three processes

| Process | File(s) | Role |
|---|---|---|
| **Electron main** | `main.js` | Orchestrator. Boots the backend, registers SDK listeners, starts/stops recordings, forwards results to the UI. |
| **Backend (Express)** | `server.js` | Bridges the app to the Recall API. Creates upload tokens; receives the completion webhook; downloads + saves transcripts. Runs *inside* the main process (`require('./server')`) but can also run standalone (`node server.js`). |
| **Renderer (UI)** | `preload.js`, `renderer.js`, `index.html`, `index.css` | The window the user sees. Shows status + the finished transcript. Has **no** Node access — talks to main only through the `window.recall` bridge. |

---

## 2. End-to-end flow, step by step

1. **App launch** (`main.js` → `app.whenReady`):
   - Starts the Express backend in-process on **port 3100** (`backend.start(3100)`).
   - Registers a callback so finished recordings get pushed to the UI (`setRecordingCompleteHandler`).
   - Registers **every** Recall SDK event listener.
   - Calls `RecallAiSdk.init(...)` **last** (this ordering is mandatory — see §6).
   - Opens the app window.

2. **Meeting detected** — the Recall native agent spots a Google Meet tab and fires `meeting-detected`. `main.js`:
   - `POST http://localhost:3100/api/create_sdk_recording`.
   - The backend calls Recall's `/api/v1/sdk_upload/` (asking for a transcript) and returns an `upload_token`.
   - `main.js` calls `RecallAiSdk.startRecording({ windowId, uploadToken })`.

3. **Recording** — the SDK records locally and streams to Recall. The UI shows "Recording in progress." On Windows the meeting URL often only arrives via `meeting-updated`.

4. **Meeting ends** — `recording-ended` / `meeting-closed` fire. The UI shows "Processing transcript…". **The app must stay open** — Recall delivers the completion webhook minutes later.

5. **Webhook** — Recall sends `sdk_upload.complete` (and `.completed`) to `POST /webhook`. The backend:
   - Returns `200` immediately (so Recall doesn't retry), then works.
   - Dedupes by `recordingId` (both webhook variants arrive for one recording).
   - Fetches the recording from Recall, polling up to 5× (3s apart) until the transcript's `download_url` appears.
   - Downloads the transcript JSON and saves it to `recordings/`.
   - Calls the handler registered in step 1.

6. **Display** — `main.js` forwards the result over IPC; `renderer.js` renders speaker-by-speaker transcript, a video link, and the saved file path.

---

## 3. Output

Transcripts are saved as flat, timestamped, **never-overwritten** files in `recordings/`:

- `<YYYY-MM-DD_HH-MM-SS>_<recordingId>.txt` — readable `Speaker: words`
- `<YYYY-MM-DD_HH-MM-SS>_<recordingId>.json` — metadata wrapper + raw transcript

The MP4 is **not** downloaded — only its URL is surfaced to the UI.

> `formatTranscript` exists in **both** `server.js` and `renderer.js` (the renderer can't import from the main process). If you change one, change the other.

---

## 4. How the project was created

It started from the standard Electron Forge + webpack template, then the Recall pieces were layered in.

1. **Scaffold** with Electron Forge's webpack template:
   ```bash
   npx create-electron-app@latest my-app --template=webpack
   ```
   This produced `main.js`, `preload.js`, `renderer.js`, `index.html`, `forge.config.js`, `webpack.*.config.js`, and `package.json`.

2. **Add the Recall SDK and backend dependencies**:
   ```bash
   npm install @recallai/desktop-sdk express dotenv electron-squirrel-startup
   npm install @timfish/forge-externals-plugin
   ```

3. **Write the backend** (`server.js`) as an Express app exporting `{ app, start, setRecordingCompleteHandler }`, callable both standalone and via `require()`.

4. **Wire the SDK into `main.js`** — boot backend → register listeners → `init()` last.

5. **Keep the SDK out of the bundle** (the single biggest gotcha) — `externals` in `webpack.main.config.js`, plus the externals plugin + asar `unpackDir` in `forge.config.js`.

6. **Build the UI** — `index.html` / `index.css` / `renderer.js`, with a minimal `contextBridge` in `preload.js`.

---

## 5. Prerequisites

| Requirement | Notes |
|---|---|
| **Windows 10+ (64-bit)** | This codebase is wired for the Windows native agent (`agent-windows.exe`). macOS 13+ (Apple Silicon) is possible but needs a different binary + full-disk access — not set up here. |
| **Node.js 18+ and npm** | Node 18+ provides global `fetch`, which both `main.js` and `server.js` rely on. |
| **Chrome or Edge** | The meeting browser. Google Meet is the detected meeting type. |
| **A Recall.ai account + API key** | From the Recall dashboard. Region matters — this app uses **us-west-2** (`https://us-west-2.recall.ai`). |
| **ngrok** (or any public tunnel) | Needed so Recall's cloud can POST the webhook back to your local backend. `ngrok.exe` is installed separately and is gitignored. |

---

## 6. Critical constraints — do NOT break these

These are the things that broke during development. Preserve them.

1. **Register every SDK listener BEFORE `RecallAiSdk.init()`.** The SDK wires its detection subsystem at init time; listeners added after never fire. `init()` is intentionally the *last* call in the ready handler.

2. **The backend uses port 3100, not 3000.** Webpack's dev server owns 3000. A clash leaves API routes unregistered → 404 on `create_sdk_recording`. `start()` resolves `null` (never throws) on `EADDRINUSE`.

3. **The Recall SDK must stay out of the webpack bundle.** It resolves its native binary relative to `__dirname`; bundling breaks `__dirname` so the agent can't launch. Enforced by `externals` (webpack) + `@timfish/forge-externals-plugin` + asar `unpackDir`.

4. **Transcription must be requested explicitly** in `create_sdk_recording` (`recording_config.transcript.provider`). Without it Recall uploads media but generates no transcript.

5. **`recording_id` is nested:** `event.data.recording.id` (mirrored at `event.data.object.recording_id`), not `event.data.recording_id`.

6. **Recall sends both `.complete` and `.completed`** for the same recording — dedupe by `recordingId`.

7. **Return `200` from the webhook immediately**, then do the slow work, so Recall never retries.

8. **Transcript media can lag upload-complete** — poll the recording up to 5× (3s apart) until the `download_url` appears.

---

## 7. Setup & run — step by step

### 7.1 First-time setup

```bash
# 1. Clone the repo, then install dependencies
npm install

# 2. Create the .env file (gitignored) from the example
cp .env.example .env
```

Edit `.env` and set your real values:

```
RECALL_API_KEY=your_real_recall_api_key
RECALL_API_URL=https://us-west-2.recall.ai
```

> The backend `process.exit(1)`s if `RECALL_API_KEY` is missing.

### 7.2 Run the full pipeline locally

The webhook half requires your local backend to be publicly reachable.

1. **Start the app:**
   ```bash
   npm start
   ```
   Watch the console for `Backend running on http://localhost:3100`.

2. **Expose the backend with ngrok** — in a second terminal:
   ```bash
   ngrok http 3100
   ```
   ⚠️ Must point at **3100**, not 3000. Copy the `https://...ngrok...` URL.

3. **Configure the webhook in the Recall dashboard** — set the webhook URL to your ngrok URL ending in `/webhook` or `/webhook/recall` (both are accepted).

4. **Run a meeting:** open a Google Meet call in Chrome. The app shows "Meeting detected → Recording in progress."

5. **End the meeting, then WAIT.** Keep the app open — Recall delivers the completion webhook minutes later. When it arrives, the transcript appears in the UI and is saved to `recordings/`.

### 7.3 Build a distributable

```bash
npm run package   # unpacked app
npm run make      # installers (squirrel/zip/deb/rpm)
```

> Note: in a packaged build, `recordings/` resolves relative to the app bundle (`__dirname`), not the project root. The local dev flow above is the intended/tested path.

---

## 8. Verifying changes

There is no test suite and no real linter (`npm run lint` is a placeholder). Verify by:

```bash
node --check server.js                            # syntax-check the backend
node --input-type=module --check < renderer.js    # syntax-check the ES-module renderer
```

…and by running the app end to end (§7.2).

---

## 9. File map

| File | Purpose |
|---|---|
| `main.js` | Electron main process — orchestrator. |
| `server.js` | Express backend — Recall API bridge + webhook handler. |
| `preload.js` | `contextBridge` exposing `window.recall.onStatus` / `onRecordingComplete`. |
| `renderer.js` | UI logic — renders status + transcript. |
| `index.html` / `index.css` | UI markup + styles. |
| `forge.config.js` | Electron Forge config — makers, plugins, asar unpack, fuses. |
| `webpack.main.config.js` | Main-process webpack — keeps the SDK external. |
| `webpack.renderer.config.js` / `webpack.rules.js` | Renderer webpack + loaders (CSS, native modules). |
| `.env` / `.env.example` | Secrets (gitignored) / template. |
| `recordings/` | Saved transcripts (created at runtime). |
| `ngrok.exe` | Local tunnel binary (installed separately, gitignored). |

---

## 10. Common problems

| Symptom | Cause / fix |
|---|---|
| `404` on `create_sdk_recording` | Port clash on 3100, or routes unregistered. Check the `Backend running on…` log; kill stale processes. |
| No `meeting-detected` event | A listener was added after `init()`, unsupported browser, or missing permissions. Check the `[Recall:…]` log lines. |
| Media uploaded but no transcript | `recording_config.transcript.provider` not sent in `create_sdk_recording`. |
| Webhook never arrives | ngrok not running / pointed at the wrong port, or the dashboard webhook URL is wrong. Must be `…/webhook` and point at 3100. |
| Transcript URL `undefined` | Media lagged — the 5×/3s poll covers most cases; check the `Transcript not ready` logs. |
| Native agent won't launch in a packaged build | SDK got bundled — verify `externals` + the externals plugin + asar `unpackDir`. |
