# voiceVault

Audio notes app with cross-note search: record or upload audio, get a transcript, then search across all notes by text or voice.

- Website: [voicevault.xyz](https://www.voicevault.xyz) (frontend on Vercel, API at `api.voicevault.xyz` on Render via Docker, PostgreSQL database).
- Apps: Android, iOS, Windows, macOS and Linux builds of the same frontend live in the NoteVault project ([1218Anubhavmishra/NoteVault](https://github.com/1218Anubhavmishra/NoteVault)).

## What it does

- Record audio in your browser (MediaRecorder; WebM, or MP4 where WebM isn't supported) or upload audio files; accounts with login, password reset by email, and account deletion from Profile
- Transcribe on the server with **ElevenLabs Scribe** (`VOICEVAULT_STT_PROVIDER=elevenlabs`, key `ELEVENLABS_API_KEY`); local faster-whisper is an optional alternative. Notes show as **processing** until ready
- Note transcripts label who spoke each line ("Speaker 1:", "Speaker 2:") and tag sounds such as laughter or music; speakers can be renamed before saving and in Edit mode
- Optional AI note titles and quick answers with OpenAI (`OPENAI_API_KEY`)
- Notes, audio and search index are stored in PostgreSQL (`DATABASE_URL`)
- Search across all notes by text or by recording a short audio query
- Jump + play **timestamped segments** from saved transcripts (clip-style playback)
- Search supports **natural language** + **time filters** (e.g. `yesterday`, `last 3 days`, `2026-04-22`)
- Search is **hybrid by default**: keyword matching + local semantic retrieval over transcript segments.
- The left column is organized into **New note**, **Processes**, and **Help**. Opening any left window restores a **50/50** split; collapsing makes Search wider. Only one window can be open at a time (mutually exclusive). On load, all three start collapsed by default; if any note is in **error**, **Processes** auto-opens (and the Processes card otherwise stays hidden unless there are failures).
- In **Help**, opening **App hint** or **UI steps** triggers the **50/50** split (no extra Help Show/Hide button).

## Run locally

Prereqs: **Node.js 22 LTS (recommended)**, ffmpeg (on PATH), a PostgreSQL database. Copy `.env.example` to `.env` and set at least `DATABASE_URL` and `ELEVENLABS_API_KEY`.

Only if you use local Whisper instead of ElevenLabs (needs Python 3.10+), install the transcription dependencies:

```powershell
.\scripts\install-ffmpeg.ps1
.\scripts\setup-transcription.ps1
```

```bash
npm install
npm run dev
```

Then open `http://localhost:5177`.

## Publish to your GitHub (1218nubhavmishra)

From the project folder in PowerShell:

```powershell
.\scripts\publish-to-github.ps1
```

## Data storage

- Notes, transcripts, audio (BYTEA) and search chunks are stored in PostgreSQL (`DATABASE_URL`; on Render use the Internal URL).
- Older local SQLite snapshots can be moved over with `scripts/migrate-sqlite-to-pg.js`. The two SQLite scripts below are kept for that legacy data only.

## One-time migration (legacy: old audio files → SQLite BLOB)

If you have older notes where audio still exists in `data/audio/` and you want to import all of them into the DB in one shot, run:

```bash
node .\scripts\migrate-audio-files-to-blob.mjs
```

To delete the old `data/audio/*` files after they are imported:

```powershell
$env:DELETE_FILES=1
node .\scripts\migrate-audio-files-to-blob.mjs
```

## Backfill timestamped segments (existing notes)

New notes automatically store **timestamped segments** (for click-to-play transcript sections).

To generate timestamps for older notes that were saved before this feature:

```bash
node .\scripts\backfill-note-timestamps.mjs
```

Optional:

- **Limit work**: `LIMIT=25 node .\scripts\backfill-note-timestamps.mjs`
- **Choose model**: `WHISPER_MODEL=tiny node .\scripts\backfill-note-timestamps.mjs`

## Troubleshooting

- If notes get stuck on **processing**, check the server console output.
- If transcription fails with ElevenLabs: check `ELEVENLABS_API_KEY` and the server log (`ELEVENLABS_STT_FAILED` shows the API's reason).
- If transcription fails with local Whisper:
  - Ensure `ffmpeg` is on PATH (`ffmpeg -version`)
  - Ensure Python 3.10+ is on PATH (`python --version`)
  - Re-run `.\scripts\setup-transcription.ps1` (creates `.venv` and installs `faster-whisper`)
