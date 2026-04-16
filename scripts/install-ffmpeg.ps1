$ErrorActionPreference = "Stop"

function Has($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Ensure-RefreshHint {
  Write-Host ""
  Write-Host "If ffmpeg still isn't found, close/reopen your terminal (PATH refresh)." -ForegroundColor Yellow
}

Write-Host "Installing ffmpeg (Windows)..." -ForegroundColor Cyan

if (Has ffmpeg) {
  Write-Host "ffmpeg is already on PATH." -ForegroundColor Green
  ffmpeg -version | Select-Object -First 1
  exit 0
}

if (Has winget) {
  Write-Host "Using winget..." -ForegroundColor Cyan
  winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
  Ensure-RefreshHint
  if (Has ffmpeg) {
    ffmpeg -version | Select-Object -First 1
    exit 0
  }
}

if (Has choco) {
  Write-Host "Using Chocolatey..." -ForegroundColor Cyan
  choco install ffmpeg -y
  Ensure-RefreshHint
  if (Has ffmpeg) {
    ffmpeg -version | Select-Object -First 1
    exit 0
  }
}

if (Has scoop) {
  Write-Host "Using Scoop..." -ForegroundColor Cyan
  scoop install ffmpeg
  Ensure-RefreshHint
  if (Has ffmpeg) {
    ffmpeg -version | Select-Object -First 1
    exit 0
  }
}

Write-Host ""
Write-Host "Couldn't install ffmpeg automatically because winget/choco/scoop weren't available or PATH didn't refresh." -ForegroundColor Yellow
Write-Host "Install one of these first, then re-run this script:" -ForegroundColor Yellow
Write-Host "  - winget (recommended, built into Windows 11)" -ForegroundColor Yellow
Write-Host "  - Chocolatey: https://chocolatey.org/install" -ForegroundColor Yellow
Write-Host "  - Scoop: https://scoop.sh/" -ForegroundColor Yellow
throw "ffmpeg not installed"

