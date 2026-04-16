$ErrorActionPreference = "Stop"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python is required (3.10+). Install it, then re-run."
}

Write-Host "Setting up offline transcription (faster-whisper)..." -ForegroundColor Cyan

if (-not (Test-Path ".venv")) {
  python -m venv .venv
}

if ($IsWindows) {
  .\.venv\Scripts\Activate.ps1
} else {
  throw "This script is Windows-only. Use your OS equivalent to activate the venv."
}

python -m pip install --upgrade pip
pip install -r server\requirements.txt

Write-Host "Done. Ensure ffmpeg is installed and on PATH." -ForegroundColor Green

