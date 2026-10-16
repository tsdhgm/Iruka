*日本語版: [windows-client_JA.md](windows-client_JA.md)*

# Running Iruka on Windows (client side)

Status: **works with FreeRDP** (2026-10-16, Windows 11 24H2 build 26100, development build).
Connected to Ubuntu (GNOME Remote Desktop) through FreeRDP 3.32.1 from vcpkg; no change to
`build.rs` or the C bridge was needed. Not yet tried: a Windows target, an installer.
The step-by-step history with the dead ends is in [windows-client-log.md](windows-client-log.md).

## Prerequisites

| What | How | Notes |
| --- | --- | --- |
| Visual Studio 2022 C++ tools | "Desktop development with C++" (Build Tools are enough) | MSVC compiles the C bridge and links |
| WebView2 | preinstalled on Windows 11 | |
| Node.js | 22 used | |
| Rust | `winget install --id Rustlang.Rustup -e` | per user, no admin; stable `x86_64-pc-windows-msvc` |
| vcpkg | `git clone https://github.com/microsoft/vcpkg.git` then `bootstrap-vcpkg.bat -disableMetrics` | |
| FreeRDP 3 | `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"` | 20 min the first time; FreeRDP 3.32.1 |
| `ssh.exe` | preinstalled (OpenSSH client) | for "+ SSH" |
| Git | Git for Windows, or WSL's git | |

## Environment

Every PowerShell session that builds or runs Iruka needs these (paths assume vcpkg in
`%USERPROFILE%\Foundry\vcpkg`; keep them in a script and dot-source it):

```powershell
$vcpkg = "$env:USERPROFILE\Foundry\vcpkg\installed\x64-windows"
$env:Path = "$env:USERPROFILE\.cargo\bin;$vcpkg\bin;$vcpkg\tools\pkgconf;" + $env:Path
$env:PKG_CONFIG = "$vcpkg\tools\pkgconf\pkgconf.exe"   # build: build.rs finds FreeRDP through pkg-config
$env:PKG_CONFIG_PATH = "$vcpkg\lib\pkgconfig"
$env:OPENSSL_MODULES = "$vcpkg\bin"                    # run: OpenSSL legacy provider, see KNOWN_ISSUES.md
```

`$vcpkg\bin` on `Path` is how `iruka.exe` finds `freerdp3.dll`, `freerdp-client3.dll`, `winpr3.dll`
and the OpenSSL / zlib / cJSON DLLs at run time.

## Build and run

```powershell
npm install
.\node_modules\.bin\tauri.cmd dev                                            # FreeRDP + IronRDP (default)
.\node_modules\.bin\tauri.cmd dev --features ironrdp -- --no-default-features # IronRDP only, no vcpkg needed
```

- Cargo flags go after the second `--`. `npm run tauri dev -- --no-default-features` does not work
  (npm hands the flag to the Tauri CLI, which rejects it).
- First build about 7 minutes; later builds 25–60 s.

## Developing from WSL

Claude Code can run inside WSL and drive the Windows build:

- Build natively on Windows: a build inside WSL produces a Linux binary that only runs under WSLg.
- Keep the clone on the Windows file system (for example `C:\Users\<user>\Foundry\Iruka`, which is
  `/mnt/c/Users/<user>/Foundry/Iruka` from WSL); WSL's git works there, so Git for Windows is optional.
- Call `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '. <env script>; …'` from bash.
  Windows processes started from WSL inherit the PATH from when WSL started, so a fresh install of
  Rust is not on it; the environment script handles that.
- Stopping the WSL-side job does not stop the Windows processes it started (tauri / vite / cargo /
  `iruka.exe`). Close the Iruka window, or `taskkill /T /F /PID <pid of tauri.js>`; otherwise the next
  build fails with `failed to remove file ...\iruka.exe`.

## What was checked (2026-10-16)

| Feature | Result |
| --- | --- |
| Window, UI | OK |
| "+ Console" | PowerShell in the user folder (after a fix to `pty.rs`; `SHELL` overrides, for example `SHELL=wsl.exe`) |
| "+ SSH" | OK through `ssh.exe` |
| FreeRDP → Ubuntu (GNOME Remote Desktop) | OK |
| Clipboard (text), both directions | OK |
| Grid view, Tab to move, select to enlarge | OK |
| Microphone → Ubuntu | OK |
| Audio playback from Ubuntu | **not working**: the sound stays on the remote; cause unknown, not yet compared with the Linux client |
| IronRDP → Ubuntu | refused, as on Linux (IronRDP has no RDPGFX) |
| Memory | about 390 MB with no session; about 1.0 GB with two 1920×1080 sessions (`iruka_mem`) |

## Not yet checked

- A Windows target (FreeRDP and IronRDP). NTLM needs the `OPENSSL_MODULES` setting above; untested.
- Audio playback (see the table above).
- Right Alt view toggle (AltGr on some layouts), fullscreen, the drop-down toolbar.
- An installer: the FreeRDP / OpenSSL DLLs, including `legacy.dll`, must ship next to `iruka.exe`
  (`bundle.resources` in the Tauri configuration), and `OPENSSL_MODULES` must point at them —
  probably set by Iruka itself at startup.
- Whether the vcpkg `ffmpeg` feature is worth adding (H.264 / AVC444 decoding).
