#!/usr/bin/env sh
# Register the development build with the desktop (GNOME, KDE, ...) so the dock
# shows Iruka's name and icon instead of a generic one.
#
# Packaged builds (deb, AppImage) carry their own .desktop file and icon; this is
# only needed for `npm run tauri dev`, whose binary has no desktop entry.
# The entry's file name matches the Tauri identifier (dev.tosihide.iruka), which is
# also the Wayland app id because tauri.conf.json sets "enableGTKAppId": true.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
app_id=dev.tosihide.iruka
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"

mkdir -p "$apps" "$icons"
cp "$repo/src-tauri/icons/icon.png" "$icons/$app_id.png"
cat > "$apps/$app_id.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Iruka
Comment=Console and remote desktop fleet viewer
Exec=$repo/src-tauri/target/debug/iruka
Icon=$app_id
Terminal=false
Categories=Network;RemoteAccess;
StartupWMClass=iruka
DESKTOP

command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "${icons%/512x512/apps}" || true
echo "Installed $apps/$app_id.desktop (restart Iruka to see the icon)"
