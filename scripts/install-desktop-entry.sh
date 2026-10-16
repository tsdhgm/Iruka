#!/usr/bin/env sh
# Register Iruka with the desktop (GNOME, KDE, ...) so the dock shows its name and
# icon instead of a generic one, and so it appears in the application menu.
#
# Works for two layouts:
#   - inside an extracted tarball (this script next to `iruka` and `iruka.png`),
#   - inside the repository (scripts/, registers the `npm run tauri dev` binary).
# Packaged builds (deb, AppImage) carry their own .desktop file and do not need this.
# The entry's file name matches the Tauri identifier (dev.tosihide.iruka), which is
# also the Wayland app id because tauri.conf.json sets "enableGTKAppId": true.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
if [ -x "$here/iruka" ]; then
	exe="$here/iruka"
	icon="$here/iruka.png"
else
	exe="$here/../src-tauri/target/debug/iruka"
	icon="$here/../src-tauri/icons/icon.png"
fi
exe=$(cd "$(dirname "$exe")" && pwd)/$(basename "$exe")

app_id=dev.tosihide.iruka
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"

mkdir -p "$apps" "$icons"
cp "$icon" "$icons/$app_id.png"
cat > "$apps/$app_id.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Iruka
Comment=Console and remote desktop fleet viewer
Exec=$exe
Icon=$app_id
Terminal=false
Categories=Network;RemoteAccess;
StartupWMClass=iruka
DESKTOP

command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "${icons%/512x512/apps}" || true
echo "Installed $apps/$app_id.desktop -> $exe (restart Iruka to see the icon)"
