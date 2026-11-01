#!/usr/bin/env bash
#
# Build the zip to upload to https://extensions.gnome.org/upload/
# Only runtime files go in: no screenshots, installer or docs.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

OUT_DIR="${1:-dist}"
mkdir -p "$OUT_DIR"
gnome-extensions pack --force \
    --extra-source=src \
    --extra-source=LICENSE \
    --out-dir="$OUT_DIR" \
    .

echo "Built $OUT_DIR/$(jq -r .uuid metadata.json 2>/dev/null || echo '*').shell-extension.zip"
