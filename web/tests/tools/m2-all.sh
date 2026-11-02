#!/bin/bash
# runs the UI driver over the 11 clips (sequentially); usage: tests/tools/m2-all.sh <outroot> [extra driver args]
cd "$(dirname "$0")/../.."
OUT=$1; shift
for f in ../test_videos/*.mp4; do
  n=$(basename "$f" .mp4)
  node tests/tools/m2-driver.mjs --clip "$f" --out "$OUT/$n" "$@" 2>/dev/null | tail -1
done
