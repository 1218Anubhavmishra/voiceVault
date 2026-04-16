$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install Node.js 18+ and re-run."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required. Install Node.js 18+ (includes npm) and re-run."
}

if (-not (Test-Path "node_modules")) {
  npm install
}

npm run dev

