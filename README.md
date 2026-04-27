# voiceVault

Local audio recording + storage app with cross-note search (audio-only).

## What it does

- Record audio in your browser (MediaRecorder)
- Upload and store audio files locally
- Auto-transcribe audio offline (faster-whisper) and store transcript in SQLite (notes show as **processing** until ready)
- Search across all notes by recording a short audio query (also transcribed offline)
- Jump + play **timestamped segments** from saved transcripts (clip-style playback)
- Search supports **natural language** + **time filters** (e.g. `yesterday`, `last 3 days`, `2026-04-22`)
- The left column is organized into **New note**, **Processes**, and **Help** windows (Show/Hide). Showing restores a 50/50 split; hiding makes Search wider. Only one window can be open at a time (mutually exclusive). On load, all three start collapsed by default; if any note is in **error**, **Processes** auto-opens.
- **Advanced search**: a collapsible panel that enables **semantic search** (local embeddings). When Advanced search is hidden, results use keyword search.
- **Quick answer**: press the Quick answer button to show top-matching clips (offline/extractive) from the current search.

## Run locally

Prereqs: **Node.js 22 LTS (recommended)**, Python 3.10+, ffmpeg (on PATH)

1) Install transcription dependencies:

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

- Audio: stored in SQLite as a BLOB (new notes), with backward compatibility for older notes that used `data/audio/`
- SQLite DB: `data/voicevault.sqlite`

Both are ignored by git.

## One-time migration (old audio files → SQLite BLOB)

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
- If transcription fails:
  - Ensure `ffmpeg` is on PATH (`ffmpeg -version`)
  - Ensure Python 3.10+ is on PATH (`python --version`)
  - Re-run `.\scripts\setup-transcription.ps1` (creates `.venv` and installs `faster-whisper`)
