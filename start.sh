#!/bin/bash
# Karma Connect AI — local dev launcher.
# Prefers a system Node.js install (any OS); falls back to the bundled runtime in .tools.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  BUNDLED="$(pwd)/.tools/node-v20.18.1-darwin-arm64/bin"
  if [ -x "$BUNDLED/node" ]; then
    export PATH="$BUNDLED:$PATH"
  else
    echo "Node.js not found. Install the LTS from https://nodejs.org and run this again."
    exit 1
  fi
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting Karma Connect AI at http://localhost:3000 ..."
npm run dev
