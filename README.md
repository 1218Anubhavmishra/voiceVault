# voiceVault

Local audio recording + storage app with cross-note search (audio-only).

## What it does

- Record audio in your browser (MediaRecorder)
- Upload and store audio files locally
- Auto-transcribe audio offline (faster-whisper) and store transcript in SQLite (notes show as **processing** until ready)
- Search across all notes by recording a short audio query (also transcribed offline)

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

- Audio files: `data/audio/`
- SQLite DB: `data/voicevault.sqlite`

Both are ignored by git.

## Troubleshooting

- If notes get stuck on **processing**, check the server console output.
- If transcription fails:
  - Ensure `ffmpeg` is on PATH (`ffmpeg -version`)
  - Ensure Python 3.10+ is on PATH (`python --version`)
  - Re-run `.\scripts\setup-transcription.ps1` (creates `.venv` and installs `faster-whisper`)
