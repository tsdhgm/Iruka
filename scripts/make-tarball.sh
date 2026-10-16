#!/usr/bin/env sh
# Build a self-contained Linux tarball: release binary + the FreeRDP 3 shared libraries
# next to it. Extract it anywhere and run ./iruka; no PATH or LD_LIBRARY_PATH needed.
#
# How it works: the binary gets an ELF RPATH of $ORIGIN/lib, so the dynamic loader
# looks in <dir of iruka>/lib before the system directories. Only FreeRDP / WinPR are
# bundled; GTK, WebKitGTK and the libraries FreeRDP itself depends on are expected from
# the distribution (Ubuntu desktop has them all; the list is written into README.txt).
#
# Usage: scripts/make-tarball.sh        -> release/iruka-<version>-linux-<arch>.tar.gz
# Needs: the normal build requirements (README.md) plus patchelf (apt install patchelf).
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

for tool in patchelf tar; do
	command -v "$tool" >/dev/null || { echo "error: $tool not found (sudo apt install $tool)" >&2; exit 1; }
done

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -n 1)
arch=$(uname -m)
name="iruka-$version-linux-$arch"
out="$repo/release"
stage="$out/$name"

echo "== Building the release binary"
npx tauri build --no-bundle
exe="$repo/src-tauri/target/release/iruka"
[ -x "$exe" ] || { echo "error: $exe was not built" >&2; exit 1; }

echo "== Staging $stage"
rm -rf "$stage"
mkdir -p "$stage/lib"
cp "$exe" "$stage/iruka"
cp LICENSE "$stage/LICENSE"
cp src-tauri/icons/icon.png "$stage/iruka.png"
cp scripts/install-desktop-entry.sh "$stage/install-desktop-entry.sh"

# FreeRDP 3 and WinPR: copy the real files under their soname, as the loader asks for them.
for entry in $(ldd "$exe" | awk '/freerdp|winpr/ { print $1 "=" $3 }'); do
	soname=${entry%%=*}
	path=${entry#*=}
	[ -f "$path" ] || { echo "error: $soname not found by ldd" >&2; exit 1; }
	cp -L "$path" "$stage/lib/$soname"
	echo "   bundled $soname <- $path"
done
# FreeRDP is Apache-2.0: ship its copyright notice with the binaries (Debian's copy).
[ -f /usr/share/doc/libfreerdp3-3/copyright ] && cp /usr/share/doc/libfreerdp3-3/copyright "$stage/lib/FreeRDP.copyright"
[ -f /usr/share/doc/libfreerdp3-3/NOTICE ] && cp /usr/share/doc/libfreerdp3-3/NOTICE "$stage/lib/FreeRDP.NOTICE"

# DT_RPATH (not RUNPATH) so that it also applies when a bundled library loads another one.
patchelf --force-rpath --set-rpath '$ORIGIN/lib' "$stage/iruka"

# What the bundled libraries need from the distribution (from the Debian package metadata).
deps=""
if command -v dpkg-query >/dev/null; then
	deps=$(for p in libfreerdp-client3-3 libfreerdp3-3 libwinpr3-3; do dpkg-query -W -f='${Depends}\n' "$p" 2>/dev/null; done \
		| tr ',' '\n' | sed 's/ *(.*//; s/^ *//' | grep -vE '^(libfreerdp|libwinpr|libc6|libgcc-s1|zlib1g)' | sort -u | tr '\n' ' ')
fi
freerdp_version=$(dpkg-query -W -f='${Version}' libfreerdp3-3 2>/dev/null || echo "3.x")

cat > "$stage/README.txt" <<README
Iruka $version (Linux $arch) - console and remote desktop fleet viewer
https://github.com/tsdhgm/Iruka

Run:
    ./iruka

No installation is needed. The binary finds the libraries in lib/ through its RPATH
(\$ORIGIN/lib), so the folder can live anywhere; do not separate iruka from lib/.

Optional: add Iruka to the application menu and give it its dock icon:
    ./install-desktop-entry.sh

Bundled in lib/: FreeRDP 3 ($freerdp_version), Apache-2.0, see lib/FreeRDP.copyright.
Expected from the distribution (all present on an Ubuntu desktop):
    GTK 3 and WebKitGTK 4.1 (libgtk-3-0t64, libwebkit2gtk-4.1-0)
    FreeRDP's own dependencies: $deps

Logs: set IRUKA_LOG to filter the diagnostic output, e.g. IRUKA_LOG=iruka_mem=debug ./iruka

Built on $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -sr), $(date +%Y-%m-%d).
README

echo "== Packing"
tar -C "$out" --owner=0 --group=0 -czf "$out/$name.tar.gz" "$name"
echo "== Check: libraries resolved from the staged binary"
ldd "$stage/iruka" | grep -E 'freerdp|winpr'
echo
echo "Wrote $out/$name.tar.gz ($(du -h "$out/$name.tar.gz" | cut -f1))"
