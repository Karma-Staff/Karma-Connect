#!/bin/bash
# One-time GitHub login via browser, then it sets up git so pushing just works.
cd "$(dirname "$0")"
export PATH="$(pwd)/.tools/gh_2.93.0_macOS_arm64/bin:$PATH"
gh auth login --hostname github.com --git-protocol https --web
echo
echo "Login finished. You can now run ./push.sh (or tell Claude 'done')."
