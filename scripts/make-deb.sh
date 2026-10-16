#!/usr/bin/env sh
# Build the Debian package: release binary, desktop entry and icons, with the FreeRDP 3 and
# WebKitGTK / GTK dependencies declared so that apt installs them (tauri.conf.json "bundle").
# Usage: scripts/make-deb.sh        -> release/iruka_<version>_<arch>.deb
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

npx tauri build --bundles deb
deb=$(ls -t src-tauri/target/release/bundle/deb/*.deb | head -n 1)
mkdir -p release
out="release/$(basename "$deb" | tr 'A-Z' 'a-z')"
cp "$deb" "$out"
echo
dpkg-deb -I "$out" | grep -E '^ (Package|Version|Architecture|Depends):'
echo
echo "Wrote $out ($(du -h "$out" | cut -f1)); install with: sudo apt install ./$out"
