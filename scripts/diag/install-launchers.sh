#!/bin/sh
# Install the diagnostic launchers for the current user (no root needed):
#   ~/.local/bin/iruka-logged        runs /usr/bin/iruka and records how it ended
#   ~/.local/bin/iruka-no-realtime   same, with the D-Bus system bus hidden (docs/realtime-kill.md)
#   ~/.local/share/applications/Iruka.desktop             the deb's entry, Exec pointed at iruka-logged
#   ~/.local/share/applications/iruka-no-realtime.desktop  a second dock entry "Iruka (no realtime)"
# Background and how to read the results: docs/linux-diagnostics.md. Undo with: $0 --remove
set -e
here=$(cd "$(dirname "$0")" && pwd)
bin=$HOME/.local/bin
apps=${XDG_DATA_HOME:-$HOME/.local/share}/applications
if [ "${1:-}" = "--remove" ]; then
  rm -f "$bin/iruka-logged" "$bin/iruka-no-realtime" "$apps/Iruka.desktop" "$apps/iruka-no-realtime.desktop"
  update-desktop-database "$apps" 2>/dev/null || true
  echo "removed; the dock uses the deb's entry again"
  exit 0
fi
[ -f /usr/share/applications/Iruka.desktop ] || { echo "the Iruka deb is not installed (/usr/share/applications/Iruka.desktop missing)" >&2; exit 1; }
mkdir -p "$bin" "$apps"
install -m 755 "$here/iruka-logged" "$here/iruka-no-realtime" "$bin/"
# Same name, icon and StartupWMClass as the deb's entry; only Exec changes.
sed "s|^Exec=iruka\$|Exec=$bin/iruka-logged|" /usr/share/applications/Iruka.desktop > "$apps/Iruka.desktop"
cat > "$apps/iruka-no-realtime.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Iruka (no realtime)
Comment=Iruka started with the D-Bus system bus hidden, so WebKit gets no real-time threads
Exec=$bin/iruka-no-realtime
Icon=iruka
Terminal=false
Categories=Network;RemoteAccess;
# No StartupWMClass on purpose: the window (app id "iruka") then always attaches to the
# "Iruka" entry, and this entry stays a plain launcher without a running indicator.
ENTRY
update-desktop-database "$apps" 2>/dev/null || true
echo "installed; exit records go to ~/.local/state/iruka/exit.log and 'journalctl --user -t iruka-exit'"
