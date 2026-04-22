$ErrorActionPreference = "Stop"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python is required (3.10+). Install it, then re-run."
}

Write-Host "Setting up offline transcription (faster-whisper)..." -ForegroundColor Cyan

if (-not (Test-Path ".venv")) {
  python -m venv .venv
}

# Avoid relying on shell activation (which varies by PowerShell version/host).
# Always install into the project venv explicitly.
$py = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  throw "Virtualenv python not found at $py. Delete .venv and re-run."
}

& $py -m pip install --upgrade pip
& $py -m pip install -r server\requirements.txt

Write-Host "Done. Ensure ffmpeg is installed and on PATH." -ForegroundColor Green

