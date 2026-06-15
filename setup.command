#!/bin/bash
# Karma Connect — one-click setup for macOS.
# Double-click this file (or run:  bash setup.command). It installs everything and starts the app.

cd "$(dirname "$0")" || exit 1
clear
echo "============================================"
echo "   Karma Connect — setup (macOS)"
echo "============================================"
echo

# 1) Node.js must be installed.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is NOT installed."
  echo "Please install the LTS version from:  https://nodejs.org"
  echo "Then double-click this file again."
  echo
  read -r -p "Press Enter to close."
  exit 1
fi
echo "Node.js found: $(node --version)"
echo

# 2) Install dependencies.
echo "Installing dependencies (this can take a minute)..."
npm install || { echo; echo "npm install failed. Check your internet connection and try again."; read -r -p "Press Enter to close."; exit 1; }
echo

# 3) Create .env with your Anthropic key (only if it doesn't exist yet).
if [ ! -f .env ]; then
  echo "Paste your Anthropic API key (it starts with sk-ant-...) and press Enter:"
  read -r KEY
  {
    echo "ANTHROPIC_API_KEY=$KEY"
    echo "VITE_SUPABASE_URL="
    echo "VITE_SUPABASE_ANON_KEY="
  } > .env
  echo ".env created."
  echo
fi

# 4) Start the app.
echo "Starting the app — open the http://localhost link shown below in your browser."
echo "(To stop the app later, press Control+C in this window.)"
echo
npm run dev
