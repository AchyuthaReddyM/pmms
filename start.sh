#!/usr/bin/env bash
# PMMS — Linux / macOS launcher
set -e
cd "$(dirname "$0")"

echo "=== PMMS - Ways Automation ==="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install from https://nodejs.org first."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

echo "Starting PMMS server..."
npm start
