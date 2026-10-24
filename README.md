*日本語版: [README_JA.md](README_JA.md)*

# Iruka

A viewer for keeping an eye on many PCs at once. Consoles (SSH and the like) and remote desktops (RDP) are lined up as live thumbnails in a sidebar on the left; click one to show it large on the right. Sessions that are not on screen stay connected and keep running.

Tauri 2 + React + TypeScript. RDP uses FreeRDP 3 (IronRDP is built in as an experimental fallback).

**Status**: an early, personal-use tool (pre-1.0). Tested with Ubuntu 26.04 LTS as the client, against Windows 11 Pro, Ubuntu GNOME Remote Desktop and macOS on Apple Silicon (macrdp) targets.

## Features

### Consoles

- Open a local shell (rendered with xterm.js).

### Remote desktop (RDP)

- **Targets**: Windows Remote Desktop, GNOME Remote Desktop (screen sharing) on Ubuntu, and a Mac with [clintcan/macrdp](https://github.com/clintcan/macrdp) installed (host is `IP:3390`).
- **Display**: one remote pixel is shown as one screen pixel (1:1). Anything that does not fit is reached by scrolling. Only the thumbnails are scaled down.
- **Cursor shape**: the cursor over the remote screen takes the shape the remote asks for (resize arrows on window borders, the I-beam over text, a hand over links, hidden while the remote hides it). FreeRDP only; with IronRDP the local arrow is shown.
- **Full screen**: hover the tab at the top centre of the screen and a toolbar slides down. It has "Fullscreen" / "Exit fullscreen", "Disconnect" and a "Keep toolbar open" toggle.
- **Grid view**: "Grid view" on the toolbar lays out every session as 16:9 tiles ("Single view" goes back). The "Columns" slider sets 1 to 6 columns; rows that do not fit scroll vertically. Clicking a tile returns to the single view of that session; the arrow keys, Tab / Shift+Tab (and Home / End) move the highlighted tile and Enter opens it. Console tiles carry a badge: "Running", "Idle 5m" or "Exited" (Running = output within the last 2 seconds; spinners such as Claude Code's keep producing output while they work, so this tells you whether a console is waiting for input).
- **View toggle key**: press and release the right Alt key on its own to switch between the grid and the single view (also in full screen). Hold right Alt and press another key and it is sent to the remote as a normal Alt. Since a lone right Alt no longer reaches the remote, do Alt-only actions (such as focusing the Windows menu bar) with the left Alt. The key can be changed through `localStorage` key `iruka.viewToggleKey` (a `KeyboardEvent.code`, e.g. `ControlRight`). There is no settings screen yet.
- **Connect form**: "Host", "User" and "Password", then the options below, and "Connect" / "Cancel".

  | Option | Meaning | Default |
  |---|---|---|
  | Resolution | "Same as local" / "2560×1440" / "1920×1080". Larger uses more memory | Same as local |
  | Backend | "Auto (FreeRDP first)" / "FreeRDP" / "IronRDP (experimental)". IronRDP has no audio, microphone, clipboard or Low memory, and cannot connect to GNOME Remote Desktop (no RDPGFX) | Auto (FreeRDP first) |
  | Audio | Play the remote's sound locally | Off |
  | Microphone | Send the local microphone to the remote | Off |
  | Low memory | Shrink the RDPGFX cache from 100 MB to 16 MB | On |
  | Clipboard | Share text copy and paste | On |

  Audio, Microphone, Low memory and Clipboard only take effect when connected through FreeRDP.

- **Clipboard (text only)**: copy and paste works in both directions between local and remote. Because many sessions are open at once, only the session on screen is synchronised.
  - **Local → remote**: when the remote screen gains focus, the local text is handed to that session. This happens when you click the remote screen, switch sessions, or come back to Iruka from another application.
  - **Remote → local**: only text copied in the session on screen goes into the local clipboard. Copies in background sessions, or while a console is on screen, are ignored.
  - Windows line endings (CRLF) and Linux line endings (LF) are converted automatically.

- **Memory check**: before connecting, the available memory is compared with an estimate of what the session needs; if there is not enough, a "Memory may run short" dialog appears with "Connect anyway" / "Cancel". The estimate is learned from actual usage. A similar dialog, "This is the local machine", appears when the host turns out to be this PC.
- **Disconnect messages**: when a session ends, the UI shows the reason with the backend name, e.g. "Disconnected (FreeRDP): The server closed the connection" or "Connection error (FreeRDP): Connection failed: …". The backend reasons are "Disconnected", "The server closed the connection", "Connection failed: …" and "Communication error: …".

### Saved connections

- **Saved connections**: every connection made from the "+ SSH" or "+ RDP" form is kept in a "Saved" list in the sidebar (`localStorage` key `iruka.profiles`); "Save" stores it without connecting. The optional "Name" is the label shown in the list (the host, or `user@host`, when left empty); connecting again to the same host and user updates the entry instead of adding one. What is saved: SSH: name, host, user and port; RDP: name, host, user and the options (Backend, Audio, Microphone, Low memory, Clipboard, Resolution). Passwords are not kept in this list. With **"Save password"** ticked in the RDP form, the password goes to the operating system's credential store instead (GNOME Keyring / KWallet through the Secret Service on Linux, the Credential Manager on Windows, the Keychain on macOS), under the connection's id; clicking that saved connection then connects right away. Without it, clicking a saved RDP connection opens the form with everything filled in except the password. Unticking it (or deleting the connection) removes the stored password. "+ SSH" (and clicking a saved SSH connection) opens a console and types `ssh user@host` for you; the host-key fingerprint and password prompts are answered in the terminal. "✎" edits an entry and "×" deletes it. The "Saved" header folds the list away (collapsed by default, remembered in `localStorage` key `iruka.savedOpen`).
- **Worksets**: the "Worksets" section of the sidebar saves the open sessions as a named set (the saved connections they came from, in sidebar order, plus the grid / single view and the column count; plain consoles are not part of it) and brings a set back with one click, also after a restart. "Last open sessions" is written automatically while sessions are open. Restoring starts the sessions one after another (an RDP session gets up to 20 s to connect before the next starts) and only as many RDP sessions as the estimated memory allows, in the saved order; the rest, and RDP connections without a saved password, are listed in the report shown at the end. Sessions already open are kept. Worksets live in `localStorage` (`iruka.worksets`, `iruka.lastWorkset`).

### Security notes

- The client passes `/cert:ignore` to FreeRDP, so server certificates are not verified (the IronRDP backend skips verification too). Use it only on a trusted LAN.
- The password is handed to FreeRDP as an in-process `/p:` argument. It does not show up in the process list, but FreeRDP prints a warning about it; moving to the settings API is planned.
- The connect form is persisted in `localStorage` (`iruka.rdpForm`): Host, User, Backend, Audio, Microphone, Low memory, Clipboard and Resolution. The password is **not** saved there; it is cleared every time the form is loaded. Saved connections (`iruka.profiles`) and worksets hold no password either.
- With "Save password" on, the password is in the OS credential store. On Linux that store is unlocked for the whole login session, so any program running in your session can read it (the same holds for Remmina, Evolution or saved Wi-Fi passwords); lock the screen when you leave. Credential entries are named `dev.tosihide.iruka` with the connection's id as the user field (e.g. visible in GNOME's Passwords and Keys).

## Limitations and known issues

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Research notes

- [docs/windows-client.md](docs/windows-client.md): running Iruka on Windows (prerequisites, FreeRDP via vcpkg; not tried yet).
- [docs/mac-target.md](docs/mac-target.md): how to use a Mac as a target, and the results of connecting through macrdp (2026-10-13).
- [docs/realtime-kill.md](docs/realtime-kill.md): why Iruka was SIGKILLed under load (WebKitGTK's real-time IPC threads), how it was traced, and the design comparison with Remmina that came out of it (2026-10-23).
- [docs/linux-diagnostics.md](docs/linux-diagnostics.md): when Iruka disappears on Linux, how to find out why (exit-status wrapper, journal, bpftrace watch); the trial and error is in [docs/linux-diagnostics-log.md](docs/linux-diagnostics-log.md) (2026-10-24).

## For contributors

- [docs/code-notes.md](docs/code-notes.md): design notes and known weak spots (architecture, threading and the FFI boundary, conventions).
- [TODO.md](TODO.md): open tasks and things still to verify.

## Installing on Linux

Both packages are built on an Ubuntu machine that has the development requirements below. Iruka is a
GTK 3 / WebKitGTK application, so it is not tied to GNOME; it has only been tested on GNOME (Wayland),
and KDE or other desktops are untested.

### Debian package (recommended on Ubuntu)

```sh
scripts/make-deb.sh                          # -> release/iruka_<version>_amd64.deb
sudo apt install ./release/iruka_0.1.0_amd64.deb
```

The package depends on Ubuntu's own FreeRDP 3 (`libfreerdp-client3-3`), WebKitGTK and GTK packages, so
apt installs whatever is missing and keeps FreeRDP updated. It installs `/usr/bin/iruka`, the desktop
entry and the icon.

### Tarball (no installation, no root)

Needs `patchelf` on the build machine:

```sh
scripts/make-tarball.sh                      # -> release/iruka-<version>-linux-x86_64.tar.gz
```

Extract it anywhere and run `./iruka`. The FreeRDP 3 libraries (a copy of Ubuntu's, frozen at the
version on the build machine) are bundled in `lib/` and found through the binary's RPATH (`$ORIGIN/lib`),
so nothing has to be installed or added to `PATH` / `LD_LIBRARY_PATH`. GTK 3, WebKitGTK 4.1 and
FreeRDP's own dependencies are expected from the distribution; an Ubuntu desktop has them all. There is
no dependency check at install time, so if `./iruka` does not start, run `./check-deps.sh`: it lists the
missing libraries and the `apt install` line for them. `./install-desktop-entry.sh` adds Iruka to the
application menu with its icon.

## Development

### Requirements (Ubuntu)

- The Tauri 2 prerequisites (see the [Tauri documentation](https://v2.tauri.app/start/prerequisites/))
- FreeRDP 3 development package: `sudo apt install freerdp3-dev`
- Node.js and Rust

### Running

```sh
npm install
npm run tauri dev
```

On a Linux desktop the dev build shows a generic dock icon until it is registered once (packaged builds do not need this):

```sh
scripts/install-desktop-entry.sh
```

The RDP diagnostic logs can be filtered with the `IRUKA_LOG` environment variable (e.g. `IRUKA_LOG=iruka_mem=debug`).

## License

MIT ([LICENSE](LICENSE))
