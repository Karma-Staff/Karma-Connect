#!/bin/bash
# Karma Connect AI — local dev launcher
# Uses the Node runtime downloaded into .tools so you don't need a system Node install.
cd "$(dirname "$0")"
export PATH="$(pwd)/.tools/node-v20.18.1-darwin-arm64/bin:$PATH"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting Karma Connect AI at http://localhost:3000 ..."
npm run dev
