---
title: voiceVault — Project Report (Web Prototype)
date: 2026-04-20
repo: voiceVault
---

## 1) Executive summary

`voiceVault` is a **local-first, voice-first** web prototype that lets you:

- **Capture** audio notes in the browser (record or upload).
- **Index** them locally by transcribing audio **offline** using Whisper via `faster-whisper`.
- **Retrieve** notes by searching across transcripts, including **voice query** search (record a short query → transcribe offline → search).

This prototype focuses on delivering the core “voice in → searchable knowledge out” loop described in `VoiceVault.md`, but implements **full‑text search (SQLite FTS5)** rather than vector/semantic search.

## 1.1) Screenshots

![voiceVault home screen (web prototype)](01-home.png)

![Left column controls (all panes collapsed)](02-left-collapsed.png)

![voiceVault home screen (all panes collapsed)](03-home-all-collapsed.png)

## 2) Scope of this prototype (what it is / isn’t)

- **Is**: A working local web app that records audio, stores it on disk, transcribes offline, and supports transcript search + audio playback/download.
- **Is not**: A mobile app, cloud service, or multi-user product; does not include authentication or cloud infrastructure (but now includes local embeddings + optional LLM answering).

## 3) Product goals aligned to `VoiceVault.md`

From `VoiceVault.md`, the three pillars are Capture / Index / Retrieve.

- **Capture (implemented)**:
  - In-browser recording (microphone).
  - File upload (audio note ingestion).
  - UI timers and “processing” status.
- **Index (implemented, local)**:
  - Offline STT using Whisper (`faster-whisper`).
  - Local SQLite persistence of metadata + transcript.
  - Background/asynchronous transcription after note creation.
  - Optional language selection + auto-detect (depending on flow).
- **Retrieve (implemented, full-text)**:
  - Search by typing.
  - Search by speaking a query (audio query → offline STT → search).

## 4) Current feature set (implemented)

### Notes

- **Create notes**
  - Record an audio note in-browser and save it.
  - Upload an existing audio file and save it as a note.
- **Background transcription**
  - On save, notes enter **`processing`** state and later become **`ready`** (or **`error`** on failure).
- **Timestamped segments (implemented)**
  - Saved notes store **timestamped segments** (start/end seconds + text) alongside the transcript.
  - UI can play **only a selected segment** (not just full-audio playback).
- **Playback & export**
  - Play note audio in the UI.
  - Download note audio.
  - Download transcript text.
- **Edit & delete**
  - Edit transcript and title (and language metadata) after processing.
  - Delete a note (removes DB row and associated audio file).
  - Retry transcription for failed notes.

### Search

- **Full-text search (SQLite FTS5)** across title + body.
- **Voice query search** (record a short “search” audio query → transcribe offline → search).
- **Semantic search (local embeddings)**
  - Optional embeddings-based retrieval over timestamped segments (local-first; embeddings computed lazily).
- **Advanced search (UI)**
  - Semantic mode is enabled via the **Advanced search** panel (Show/Hide).
- **Quick answer (extractive, offline)**
  - The UI shows top matching timestamped segments **only when the user presses the Quick answer button**.
- **LLM Q&A (optional)**
  - Optional LLM answering is available via Ask mode (OpenAI or Ollama if configured); otherwise the UI stays in offline/extractive mode.
- **Natural-language query rewrite (offline)**
  - Queries like “find me the note where I talked about recording” are rewritten into keyword-style queries.
- **Date/time filters in search (offline)**
  - Supports filters like `today`, `yesterday`, `last 3 days`, `2026-04-22`, and `between 2026-04-20 and 2026-04-22`.
- **Best-match segment highlighting**
  - Search results can highlight the best matching segment in a note (for quick jump/play).
- **Multi-clip results (implemented)**
  - Search can return multiple top-matching timestamped segments per note (clip-style retrieval).
- **Quick answer (extractive, implemented)**
  - UI shows a “Quick answer” box composed from top matching timestamped segments (offline, extractive — not LLM-generated).
- **Robustness improvements**:
  - FTS query normalization to avoid punctuation/operator errors.
  - Fallback to safe substring search when FTS throws.

### Language + models

- **Language selection**: UI can request a specific language code, or allow auto-detect (depending on endpoint).
- **Fast mode vs quality mode**:
  - “Fast mode” uses `tiny` by default.
  - “Quality mode” uses `medium` by default.
  - Both are configurable via env vars (see below).
- **UI toggles**
  - Fast mode and Semantic search are exposed as simple **dot toggles** (green = on).

### UI layout (current)

- The left column is organized into three windows: **New note**, **Processes**, and **Help** (App hint + UI steps).
- Each window has a **Show/Hide** control.
- Pressing **Show/+** restores a **50/50** split with the Search window; pressing **Hide** widens Search.
- The three windows are **mutually exclusive** (opening one closes the other two). On load, all three start collapsed by default; if any note is in **error**, **Processes** auto-opens.

## 5) Architecture and data flow

### Components

- **Frontend**: Static UI in `public/` (vanilla HTML/CSS/JS).
- **Backend**: Node.js + Express in `server/`.
- **DB**: SQLite via `better-sqlite3`.
- **Transcription**: Python (`server/transcribe.py`) using `faster-whisper`; requires `ffmpeg` on PATH.

### Storage (local-first)

- **Audio**: stored in SQLite as a **BLOB** for new notes, with backward compatibility for older notes that used `data/audio/`
- **Database**: `data/voicevault.sqlite`

These are intentionally local runtime artifacts (not meant to be committed).

### Note creation flow (simplified)

1. Browser records or uploads audio.
2. Backend `POST /api/notes` stores audio in SQLite (BLOB) and inserts a DB row as `processing`.
3. Backend runs offline transcription asynchronously (Python).
4. Backend updates DB row with transcript, detected/selected language, and final status.

### Search flow (simplified)

- **Text search**: `GET /api/notes?q=...` runs FTS5 (or safe LIKE fallback).
- **Voice search**: UI records query audio → `POST /api/transcribe` → uses returned transcript as the search string.

## 6) Tech stack

- **Node.js**: `>=20` (see `package.json`)
- **Backend**: Express, Multer (uploads)
- **SQLite**: `better-sqlite3`
- **Python**: 3.10+
- **Offline STT**: `faster-whisper`
- **Media**: `ffmpeg` on PATH

## 7) Configuration (env vars)

The server supports these environment variables:

- `PORT`: server port (default `5177`)
- `WHISPER_MODEL`: main/quality model (default: `medium`)
- `WHISPER_FAST_MODEL`: fast model (default: `tiny`)
- `WHISPER_LANG_MODEL`: model for language detection/live preview (default: `tiny`)
- `WHISPER_LANGUAGE`: default language override (empty = auto where supported)
- `VOICEVAULT_VAD`: `1` to enable VAD filtering; default is off (`0`)

## 8) Local run & testing (Windows-focused)

### Prerequisites

- Node.js 20+
- Python 3.10+
- `ffmpeg` installed and on PATH

### One-time setup

Run from project root:

```powershell
.\scripts\install-ffmpeg.ps1
.\scripts\setup-transcription.ps1
```

Then:

```bash
npm install
npm run dev
```

Open `http://localhost:5177`.

### Test plan (quick)

- **Record → Save**: record 10–20 seconds, save; confirm note appears as `processing` then `ready`.
- **Playback**: play audio; confirm it matches recording.
- **Transcript**: confirm transcript is visible; edit it and verify it persists.
- **Search by text**: search for a phrase from transcript; confirm note appears.
- **Search by voice**: record a short search query; confirm results match.
- **Delete**: delete a note; confirm it disappears and audio is removed.
- **Failure path**: break Python/ffmpeg temporarily; confirm note becomes `error`; then fix deps and click retry.

## 9) Known constraints (current prototype)

- Embeddings-based semantic retrieval is implemented locally, but is **segment-level** (not word-level alignment).
- LLM answers are **optional** and require an OpenAI key; the offline fallback is extractive.
- **Single-user local app** (no auth, no cloud sync).
- **CPU-only transcription** by default; long notes can take time and can be hardware dependent.
- **No diarization / speaker labels**.

## 10) Cross-check vs original documents (what’s still missing)

This section cross-checks the current prototype against the “semantic search / voice Q&A” blueprint in `VoiceVault.md` and the baseline goals described in `report1.md`.

### Missing relative to `VoiceVault.md` (blueprint)

- **Semantic retrieval (partially addressed)**:
  - Local embeddings-based retrieval exists for segments.
  - Missing: vector DB, ANN indexing for large scale, and a richer reranking pipeline.
- **Grounded Q&A (partially addressed)**:
  - Optional LLM answering exists and is grounded in retrieved clips with citations.
  - Missing: stronger safety/guardrails, evals, and long-context scaling.
- **Timestamp-level results (partially addressed)**:
  - Prototype now stores **timestamped segments** and supports **segment-level** “jump and play”.
  - Still missing: word-level alignment, semantic chunks, and returning multiple precise clips per query with robust ranking.
- **Chunking pipeline**:
  - No semantic chunking (100–200 token chunks) or pause/topic segmentation stored as searchable units.
- **Mobile-first product**:
  - Prototype is a local web app, not React Native/Flutter iOS/Android.
- **Cloud components**:
  - No ingestion service queue, blob storage (S3), Postgres, auth (Supabase/Firebase), etc.
- **Product surfaces**:
  - No proactive reminders, integrations (calendar/reminders/contacts), collaboration, or ambient mode.

### Items from `report1.md` (baseline) that are covered

- In-browser recording + upload
- Local storage (`data/`)
- Offline transcription + SQLite persistence
- Audio query search
- Segment-level playback from transcript timestamps

### `VoiceVault.docx`

`VoiceVault.docx` is present in the repo and its extracted content matches the same blueprint/requirements described in `VoiceVault.md` (capture → transcribe/index → semantic retrieval → grounded answers + timestamped clips). The “missing” items above therefore apply equally to `VoiceVault.docx`.

