#!/bin/bash
cd "$(dirname "$0")"
export PATH="$(pwd)/.tools/gh_2.93.0_macOS_arm64/bin:$PATH"
git push -u origin main
