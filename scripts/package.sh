#!/bin/sh
# Builds one zip of the extension that uploads unchanged to the Chrome Web Store
# and to Firefox Add-ons, and that people can download from GitHub Releases.
# Run from the repository root:  sh scripts/package.sh
set -e
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/manifest.json)
mkdir -p dist
OUT="$PWD/dist/ReviewNudge-$VERSION.zip"
rm -f "$OUT"
(cd extension && zip -qr "$OUT" . -x '*.DS_Store')
echo "Built dist/ReviewNudge-$VERSION.zip"
