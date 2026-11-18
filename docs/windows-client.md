*日本語版: [windows-client_JA.md](windows-client_JA.md)*

# Running Iruka on Windows (client side)

Status: **works with FreeRDP** (2026-10-16, Windows 11 24H2 build 26100, development build).
Connected to Ubuntu (GNOME Remote Desktop) through FreeRDP 3.32.1 from vcpkg; no change to
`build.rs` or the C bridge was needed. Also connected to a Windows target (NLA, audio, microphone, clipboard). IronRDP to Windows works too. Not yet tried: an installer.
The step-by-step history with the dead ends is in [windows-client-log.md](windows-client-log.md).

## Prerequisites

| What | How | Notes |
| --- | --- | --- |
| Visual Studio C++ tools | "Desktop development with C++" (Community or Build Tools) | MSVC compiles the C bridge and links; 2022 used first, Community 2026 also works |
| vcpkg | see [vcpkg](#vcpkg) below | builds FreeRDP 3 and its libraries from `vcpkg.json` |
| WebView2 | preinstalled on Windows 11 | |
| Scripts allowed in PowerShell | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force`, once | per user, no admin, every window from then on. Windows runs no `.ps1` by default, so `npm` (`npm.ps1`) and `. scripts\windows-env.ps1` fail with "running scripts is disabled on this system". Check with `Get-ExecutionPolicy`. To change nothing permanently: `Set-ExecutionPolicy -Scope Process Bypass -Force` at the start of every window |
| Node.js | `winget install --id OpenJS.NodeJS.LTS -e` (nodejs.org's MSI) | 24 or newer; 22, 24 and 26 used. All users, asks for admin approval once. Keep to this one installation (no nvm-windows / Chocolatey / Scoop / Store Node.js beside it); open a new PowerShell, check with `node -v` |
| Rust | `winget install --id Rustlang.Rustup -e` (or rustup-init.exe from rustup.rs) | per user, no admin; this one command also installs the stable `x86_64-pc-windows-msvc` toolchain, nothing else to install (check in a new PowerShell with `rustup show`) |
| `ssh.exe` | preinstalled (OpenSSH client) | for "+ SSH" |
| Git | Git for Windows (native setup), or WSL's git (WSL setup) | vcpkg needs Git too |
| Smart App Control off | Windows Security → App & browser control | otherwise the built `iruka.exe` is blocked (os error 4551); see KNOWN_ISSUES.md |

Visual Studio does not need to be on `Path`, and no restart is needed after installing it: cargo
and `scripts\windows-deps.ps1` find it through `vswhere.exe`.

## vcpkg

Iruka uses vcpkg in **manifest mode**: `vcpkg.json` at the repository root names the libraries
(`freerdp[client]`, `pkgconf`) and pins their versions with `builtin-baseline`, and they are built
into `vcpkg_installed\x64-windows\` inside the clone (ignored by git). Any vcpkg will do; it only
has to be found:

1. **You already develop with Visual Studio.** If you have your own clone of microsoft/vcpkg, set
   `VCPKG_ROOT` to it (a Developer PowerShell sets it too); `git pull` it first if it is older than
   the baseline in `vcpkg.json`. Otherwise use the vcpkg that comes with Visual Studio: in Visual
   Studio Installer → Modify → Individual components, tick "vcpkg package manager" if it is not
   there yet (an older Community 2022 installation may lack it).
2. **You install a build environment for Iruka for the first time.** Install Visual Studio
   Community 2026 with "Desktop development with C++" and its default selection: that includes
   "vcpkg package manager" (checked 2026-11-18). Nothing else to do.

Then, from the clone (10–20 minutes the first time):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows-deps.ps1
```

The script takes `-Vcpkg <path to vcpkg.exe>`, else `$env:VCPKG_ROOT\vcpkg.exe`, else Visual
Studio's. Visual Studio's vcpkg has no classic mode (`vcpkg install <port>` outside a manifest fails
with "this vcpkg instance requires a manifest"), which is why the repository carries `vcpkg.json`.
To move to newer library versions, run `vcpkg x-update-baseline` in the clone and commit the
changed `vcpkg.json`.

## Two ways to develop

Both build natively on Windows; they differ in where the shell (and Claude Code) runs.

| | Native (PowerShell) | From WSL |
| --- | --- | --- |
| Shell, Claude Code | PowerShell, Claude Code for Windows | bash in WSL, Claude Code for Linux |
| Clone | anywhere on the Windows file system, for example `C:\src\iruka` | on the Windows file system; it can be the same clone as the native setup (`/mnt/c/src/iruka` from WSL) |
| Git | Git for Windows | WSL's git |
| Build commands | run directly after dot-sourcing the environment script | through `powershell.exe`, see [Developing from WSL](#developing-from-wsl) |

The prerequisites, the libraries in `vcpkg_installed` and the environment script are shared. Do not
let both setups build the same clone at once (they share `src-tauri\target`).

## Environment

Every PowerShell session that builds or runs Iruka needs vcpkg's libraries on `Path` and a few
variables. `scripts\windows-env.ps1` sets them, with every path relative to the clone; dot-source it:

```powershell
. scripts\windows-env.ps1
```

If this answers "cannot be loaded because running scripts is disabled on this system", PowerShell is
not allowed to run scripts yet: see "Scripts allowed in PowerShell" under Prerequisites.

What it sets (`$v` is `<clone>\vcpkg_installed\x64-windows`): `$v\bin` and `$v\tools\pkgconf` on
`Path` (`$v\bin` is how `iruka.exe` finds `freerdp3.dll`, `freerdp-client3.dll`, `winpr3.dll` and the
OpenSSL / zlib / cJSON DLLs at run time); `PKG_CONFIG` and `PKG_CONFIG_PATH`, through which
`build.rs` finds FreeRDP; and `OPENSSL_MODULES`, OpenSSL's legacy provider for NTLM (KNOWN_ISSUES.md).

## Build and run

In a native PowerShell, from the clone:

```powershell
. scripts\windows-env.ps1
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

`--no-bundle` stops after the exe: without it `tauri build` would also make an MSI and an NSIS
setup.exe (`tauri.conf.json` has `"targets": "all"`), which would not contain the FreeRDP DLLs.

Then `powershell -ExecutionPolicy Bypass -File scripts\make-zip.ps1` stages and zips everything into
`release\iruka-<version>-windows-x64.zip` (since 2026-10-26; it also adds the FreeRDP and OpenSSL
copyright files). What it does, by hand: put next to `iruka.exe`, from `vcpkg_installed\x64-windows\bin`: `freerdp3.dll`,
`freerdp-client3.dll`, `winpr3.dll`, `libcrypto-3-x64.dll`, `libssl-3-x64.dll`, `legacy.dll`,
`libz.dll` (`z.dll` before vcpkg's zlib 1.4), `cjson.dll` (not `pkgconf-8.dll`, not the `.pdb` files), plus `LICENSE.txt` and a short
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
- Keep the clone on the Windows file system (for example `C:\src\iruka`, which is `/mnt/c/src/iruka`
  from WSL); WSL's git works there, so Git for Windows is optional. Windows paths ignore case, so
  `C:\src\Iruka` and `C:\src\iruka` are the same folder, although WSL spells them differently.
- Call `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '. scripts\windows-env.ps1; …'` from bash.
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
