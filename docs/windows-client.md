*日本語版: [windows-client_JA.md](windows-client_JA.md)*

# Running Iruka on Windows (client side)

Status: **works with FreeRDP** (2026-10-16, Windows 11 24H2 build 26100, development build).
Connected to Ubuntu (GNOME Remote Desktop) through FreeRDP 3.32.1 from vcpkg; no change to
`build.rs` or the C bridge was needed. Also connected to a Windows target (NLA, audio, microphone, clipboard). IronRDP to Windows works too. Not yet tried: an installer.
The step-by-step history with the dead ends is in [windows-client-log.md](windows-client-log.md).

## Prerequisites

| What | How | Notes |
| --- | --- | --- |
| Visual Studio C++ tools | "Desktop development with C++" (Build Tools are enough) | MSVC compiles the C bridge and links; 2022 used first, Community 2026 (18.11) also works (2026-10-26) |
| WebView2 | preinstalled on Windows 11 | |
| Node.js | 22 and 26 used | |
| Rust | `winget install --id Rustlang.Rustup -e` | per user, no admin; stable `x86_64-pc-windows-msvc` |
| vcpkg | `git clone https://github.com/microsoft/vcpkg.git` then `bootstrap-vcpkg.bat -disableMetrics` | |
| FreeRDP 3 | `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"` | 20 min the first time; FreeRDP 3.32.1 |
| `ssh.exe` | preinstalled (OpenSSH client) | for "+ SSH" |
| Git | Git for Windows (native setup), or WSL's git (WSL setup) | |
| Smart App Control off | Windows Security → App & browser control | otherwise the built `iruka.exe` is blocked (os error 4551); see KNOWN_ISSUES.md |

## Two ways to develop

Both build natively on Windows; they differ in where the shell (and Claude Code) runs.

| | Native (PowerShell) | From WSL |
| --- | --- | --- |
| Shell, Claude Code | PowerShell, Claude Code for Windows | bash in WSL, Claude Code for Linux |
| Clone | anywhere on the Windows file system, for example `%USERPROFILE%\Foundry\iruka` | on the Windows file system; it can be the same clone as the native setup (`/mnt/c/Users/<user>/Foundry/iruka` from WSL) |
| Git | Git for Windows | WSL's git |
| Build commands | run directly after dot-sourcing the environment script | through `powershell.exe`, see [Developing from WSL](#developing-from-wsl) |

The prerequisites, vcpkg and the environment script below are shared; one vcpkg installation serves
both. Do not let both setups build the same clone at once (they share `src-tauri\target`).

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

In a native PowerShell, from the clone:

```powershell
. $env:USERPROFILE\Foundry\iruka-env.ps1
npm install
.\node_modules\.bin\tauri.cmd dev                                            # FreeRDP + IronRDP (default)
.\node_modules\.bin\tauri.cmd dev --features ironrdp -- --no-default-features # IronRDP only, no vcpkg needed
```

- Cargo flags go after the second `--`. `npm run tauri dev -- --no-default-features` does not work
  (npm hands the flag to the Tauri CLI, which rejects it).
- First build about 7 minutes; later builds 25–60 s.
- After moving or renaming the clone, run `cargo clean` in `src-tauri` once. Tauri's build scripts
  keep absolute paths into the old `target` folder, so the next build fails with `failed to read
  plugin permissions: failed to read file '\\?\C:\<old path>\src-tauri\target\…\app_hide.toml'`.
- **Red `NativeCommandError` / `RemoteException` lines at startup are harmless.** With `2>&1` (for
  example to keep a log with `Tee-Object`), Windows PowerShell 5.1 wraps each line a native program
  writes to stderr in an error record, and prints the first one in red with `At line:1 char:…`,
  `CategoryInfo : NotSpecified: (… Running BeforeDevCommand (`npm run dev`) …) [], RemoteException`
  and `FullyQualifiedErrorId : NativeCommandError`. Despite the words "Exception" and "Error",
  nothing failed: Tauri and cargo simply write their progress messages ("Running …", "Compiling …",
  "Finished …") to stderr, and the message itself is inside the parentheses. `RemoteException` is
  only PowerShell's name for "text that came from another program's stderr". To avoid the noise, let
  cmd do the redirection; the log keeps everything:

  ```powershell
  [Console]::OutputEncoding = [Text.Encoding]::UTF8   # optional: vite's "➜" otherwise shows as "Ô×£"
  cmd /c ".\node_modules\.bin\tauri.cmd dev 2>&1" | Tee-Object -FilePath $env:USERPROFILE\iruka-dev.log
  ```

  PowerShell 7 (`pwsh`) does not do this wrapping at all.
- npm 11 and later warn that esbuild's postinstall script is "not yet covered by allowScripts" and
  skip it. Harmless: the esbuild binary comes from the `@esbuild/win32-x64` package, and
  `npm run build` works.

## Portable zip

For use without a development environment (unsigned; see TODO.md for the distribution plan):

```powershell
.\node_modules\.bin\tauri.cmd build --no-bundle   # src-tauri\target\release\iruka.exe, frontend embedded (about 10 min)
```

Then `powershell -ExecutionPolicy Bypass -File scripts\make-zip.ps1` stages and zips everything into
`release\iruka-<version>-windows-x64.zip` (since 2026-10-26; it also adds the FreeRDP and OpenSSL
copyright files). What it does, by hand: put next to `iruka.exe`, from vcpkg's `installed\x64-windows\bin`: `freerdp3.dll`,
`freerdp-client3.dll`, `winpr3.dll`, `libcrypto-3-x64.dll`, `libssl-3-x64.dll`, `legacy.dll`,
`z.dll`, `cjson.dll` (not `pkgconf-8.dll`, not the `.pdb` files), plus `LICENSE.txt` and a short
`README.txt`, and zip the folder. 2026-10-16: 26 MB unpacked, 9.7 MB zipped.

At startup on Windows Iruka sets `OPENSSL_MODULES` to its own folder when `legacy.dll` is there and
the variable is unset (`src-tauri/src/lib.rs`), so NTLM works without any setup. This only works
since 2026-10-26: before that the variable was set in a way OpenSSL did not see, and the zip logged
`OpenSSL LEGACY provider failed to load` on connect (KNOWN_ISSUES.md). Check after a change: connect
from the unpacked folder with `OPENSSL_MODULES` unset; the log must have no `LEGACY` / `md4` / `rc4`
line.

## Developing from WSL

Claude Code can run inside WSL and drive the Windows build (the 2026-10-16 setup):

- Build natively on Windows: a build inside WSL produces a Linux binary that only runs under WSLg.
- Keep the clone on the Windows file system (for example `C:\Users\<user>\Foundry\iruka`, which is
  `/mnt/c/Users/<user>/Foundry/iruka` from WSL); WSL's git works there, so Git for Windows is optional.
  Windows paths ignore case, so `Foundry\Iruka` and `Foundry\iruka` are the same folder.
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
| Audio playback from Ubuntu | the sound stays on the remote, although the WinMM backend is loaded; probably GNOME Remote Desktop behaviour, not yet compared with the Linux client |
| FreeRDP → Windows (3840×2160, NLA / NTLM) | OK |
| Audio, microphone, clipboard with a Windows target | OK (sound played locally, microphone reaches the remote, clipboard both ways) |
| IronRDP → Windows | OK (no audio / microphone, as on Linux: only wired for FreeRDP) |
| Right Alt view toggle | OK (Japanese layout; AltGr layouts not tried) |
| Fullscreen, drop-down toolbar | OK |
| IronRDP → Ubuntu | refused, as on Linux (IronRDP has no RDPGFX) |
| Memory (`iruka_mem`) | about 390 MB with no session; about 1.0 GB with two 1920×1080 sessions; about 1.6 GB with one 3840×2160 session; not returned after a session closes (not yet compared with Linux) |

## Not yet checked

- Right Alt view toggle on layouts where it is AltGr.
- An installer: the FreeRDP / OpenSSL DLLs, including `legacy.dll`, must ship next to `iruka.exe`
  (`bundle.resources` in the Tauri configuration), and `OPENSSL_MODULES` must point at them —
  probably set by Iruka itself at startup.
- Whether the vcpkg `ffmpeg` feature is worth adding (H.264 / AVC444 decoding).
