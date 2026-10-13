*日本語版: [README_JA.md](README_JA.md)*

# Iruka

A viewer for keeping an eye on many PCs at once. Consoles (SSH and the like) and remote desktops (RDP) are lined up as live thumbnails in a sidebar on the left; click one to show it large on the right. Sessions that are not on screen stay connected and keep running.

Tauri 2 + React + TypeScript. RDP uses FreeRDP 3 (IronRDP is built in as a fallback).

**Status**: an early, personal-use tool (pre-1.0). Tested with Ubuntu 26.04 as the client, against Windows (Pro), Ubuntu GNOME Remote Desktop and macOS (macrdp) targets.

## Features

### Consoles

- Open a local shell (rendered with xterm.js).

### Remote desktop (RDP)

- **Targets**: Windows Remote Desktop, GNOME Remote Desktop (screen sharing) on Ubuntu, and a Mac with [clintcan/macrdp](https://github.com/clintcan/macrdp) installed (host is `IP:3390`).
- **Display**: one remote pixel is shown as one screen pixel (1:1). Anything that does not fit is reached by scrolling. Only the thumbnails are scaled down.
- **Full screen**: hover the tab at the top centre of the screen and a toolbar slides down. It has "Fullscreen" / "Exit fullscreen", "Disconnect" and a "Keep toolbar open" toggle.
- **Grid view**: "Grid view" on the toolbar lays out every session as 16:9 tiles ("Single view" goes back). The "Columns" slider sets 1 to 6 columns; rows that do not fit scroll vertically. Clicking a tile returns to the single view of that session. Console tiles carry a badge: "Running", "Idle 5m" or "Exited" (Running = output within the last 2 seconds; spinners such as Claude Code's keep producing output while they work, so this tells you whether a console is waiting for input).
- **View toggle key**: press and release the right Alt key on its own to switch between the grid and the single view (also in full screen). Hold right Alt and press another key and it is sent to the remote as a normal Alt. Since a lone right Alt no longer reaches the remote, do Alt-only actions (such as focusing the Windows menu bar) with the left Alt. The key can be changed through `localStorage` key `iruka.viewToggleKey` (a `KeyboardEvent.code`, e.g. `ControlRight`). There is no settings screen yet.
- **Connect form**: "Host", "User" and "Password", then the options below, and "Connect" / "Cancel".

  | Option | Meaning | Default |
  |---|---|---|
  | Resolution | "Same as local" / "2560×1440" / "1920×1080". Larger uses more memory | Same as local |
  | Backend | "Auto (FreeRDP first)" / "FreeRDP" / "IronRDP" | Auto (FreeRDP first) |
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

### Security notes

- The client passes `/cert:ignore` to FreeRDP, so server certificates are not verified (the IronRDP backend skips verification too). Use it only on a trusted LAN.
- The password is handed to FreeRDP as an in-process `/p:` argument. It does not show up in the process list, but FreeRDP prints a warning about it; moving to the settings API is planned.
- The connect form is persisted in `localStorage` (`iruka.rdpForm`): Host, User, Backend, Audio, Microphone, Low memory, Clipboard and Resolution. The password is **not** saved; it is cleared every time the form is loaded.

## Limitations and known issues

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Research notes

- [docs/mac-target.md](docs/mac-target.md): how to use a Mac as a target, and the results of connecting through macrdp (2026-10-13).

## For contributors

- [docs/code-notes.md](docs/code-notes.md): design notes and known weak spots (architecture, threading and the FFI boundary, conventions).

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

The RDP diagnostic logs can be filtered with the `IRUKA_LOG` environment variable (e.g. `IRUKA_LOG=iruka_mem=debug`).

## License

MIT ([LICENSE](LICENSE))
