#!/usr/bin/env sh
# Run this from an extracted Iruka tarball when ./iruka does not start.
# It lists the shared libraries that iruka and the bundled lib/*.so cannot find and,
# on Debian / Ubuntu, the apt command that installs them. The soname -> package table
# (lib/packages.txt) was recorded on the machine the tarball was built on.
set -u

here=$(cd "$(dirname "$0")" && pwd)
# lib/ is on the binary's RPATH, but ldd of the bundled libraries themselves needs it too.
missing=$(LD_LIBRARY_PATH="$here/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
	ldd "$here/iruka" "$here"/lib/*.so* 2>/dev/null | awk '/not found/ { print $1 }' | sort -u)

if [ -z "$missing" ]; then
	echo "All shared libraries found; ./iruka should start."
	exit 0
fi

echo "Missing shared libraries:"
pkgs=""
for so in $missing; do
	pkg=$(awk -v s="$so" '$1 == s { print $2 }' "$here/lib/packages.txt" 2>/dev/null)
	if [ -n "$pkg" ]; then
		echo "    $so  (package $pkg)"
		pkgs="$pkgs $pkg"
	else
		echo "    $so  (package unknown)"
	fi
done
pkgs=$(printf '%s\n' $pkgs | sort -u | tr '\n' ' ')
if [ -n "$pkgs" ]; then
	echo
	echo "On Ubuntu / Debian, install them with:"
	echo "    sudo apt install $pkgs"
fi
exit 1
