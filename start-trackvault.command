#!/usr/bin/env bash
# ------------------------------------------------------------------
# TrackVault - double-click launcher (macOS / Linux)
# Installs dependencies on first run, builds, then serves the app and
# opens it in your default browser. Close this window or press Ctrl+C to stop.
# ------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "ERROR: Node.js is not installed."
  echo "Install the LTS build from https://nodejs.org/ then run this again."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies. This only happens once..."
  npm install
fi

echo "Building the app..."
npm run build

echo
echo "=========================================================="
echo " TrackVault is starting."
echo " Your browser will open automatically at localhost:1420"
echo " Keep this window open while you use it."
echo " Press Ctrl+C here to stop."
echo "=========================================================="
echo

npm run preview -- --port 1420 --strictPort --open