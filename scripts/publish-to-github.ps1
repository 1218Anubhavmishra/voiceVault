$ErrorActionPreference = "Stop"

function Ensure-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $name"
  }
}

Ensure-Command git
Ensure-Command gh

Write-Host "Publishing voiceVault to GitHub (1218nubhavmishra/voiceVault)..." -ForegroundColor Cyan

if (-not (Test-Path ".git")) {
  git init
}

git add -A

try {
  git commit -m "Initial commit: voiceVault audio notes app"
} catch {
  # ignore "nothing to commit"
}

try {
  gh auth status | Out-Null
} catch {
  Write-Host "You are not logged into GitHub CLI. Starting login..." -ForegroundColor Yellow
  gh auth login
}

# Create repo (idempotent-ish; if already exists, we just set remote)
try {
  gh repo create "1218nubhavmishra/voiceVault" --source . --public --push
  exit 0
} catch {
  Write-Host "Repo may already exist; setting origin and pushing..." -ForegroundColor Yellow
}

git remote remove origin 2>$null
git remote add origin "https://github.com/1218nubhavmishra/voiceVault.git"

git branch -M main
git push -u origin main

Write-Host "Done." -ForegroundColor Green

