*日本語版: [windows-client_JA.md](windows-client_JA.md)*

# Running Iruka on Windows (client side)

Status: **step 1 works** (2026-10-16, Windows 11 24H2 build 26100); step 2 (FreeRDP) in progress.
Update this file with what actually happened.

## Prerequisites

- Tauri 2 on Windows: Microsoft Visual Studio C++ Build Tools (Desktop development with C++),
  the WebView2 runtime (preinstalled on Windows 11), Rust (MSVC toolchain, `rustup`), Node.js.
  See https://v2.tauri.app/start/prerequisites/.
- OpenSSH client (`ssh.exe`), preinstalled on Windows 10/11; needed by the "+ SSH" feature, which
  types `ssh user@host` into a console.
- Git.

## Step 1: build without FreeRDP (pure Rust)

The C bridge needs FreeRDP 3, which Windows does not ship. First confirm that everything else
(Tauri, WebView2, the PTY consoles, the UI) works:

```powershell
git clone https://github.com/tsdhgm/Iruka.git
cd Iruka
npm install
.\node_modules\.bin\tauri.cmd dev --features ironrdp -- --no-default-features
```

Expected: the window opens, "+ Console" opens a PowerShell/cmd console (portable-pty uses ConPTY),
"+ SSH" types the ssh command, and "+ RDP" with Backend "IronRDP" connects to a Windows target
(no audio / microphone / clipboard, and GNOME Remote Desktop targets are refused — IronRDP has no
RDPGFX; see KNOWN_ISSUES.md).

Things to check on Windows specifically:

### Result (2026-10-16)

Setup: the repository was edited from Claude Code inside WSL, but built and run natively on Windows
(a build inside WSL produces a Linux binary). Rust was installed with
`winget install Rustlang.Rustup` (per user, stable `x86_64-pc-windows-msvc`); Node.js 22,
Visual Studio 2022 C++ tools, WebView2 and `ssh.exe` were already present. The clone lives at
`C:\Users\<user>\Foundry\Iruka` (cloned with WSL's git; Git for Windows is not required).
First `cargo build`: about 7 minutes, 4 dead-code warnings (FreeRDP-only code).

- `npm run tauri dev -- --no-default-features …` does not work: npm passes the flag to the Tauri
  CLI, which rejects it. Cargo flags go after a second `--`, as in the command above.
- Window, UI: OK.
- "+ Console": first opened WSL bash, because `$SHELL` is unset on Windows and the fallback `bash`
  resolved to `System32\bash.exe` (the WSL launcher); the working directory was not the home folder
  (`$HOME` unset). Fixed in `src-tauri/src/pty.rs`: the fallback is now `powershell.exe` and the home
  folder falls back to `%USERPROFILE%`. Setting `SHELL` (for example `SHELL=wsl.exe`) still overrides.
- "+ SSH": OK, `ssh.exe` connects.
- "+ RDP" with IronRDP to Ubuntu (GNOME Remote Desktop): refused as expected (no RDPGFX in IronRDP;
  the error ends in "received disconnect provider ultimatum"). The built-in Windows Remote Desktop
  client connects to the same target.
- IronRDP to a Windows target: not tried yet (a separate Windows target will be prepared).

Still to check:

- The view-toggle key (right Alt) and the window-level key listener were only tested on
  GNOME/Wayland. On Windows, right Alt is AltGr on some layouts.
- Fullscreen (`setFullscreen`) and the drop-down toolbar.
- Memory check: `sysinfo` works on Windows; the model file lives in the Tauri app-data directory.
- Clipboard: `arboard` supports Windows.

## Step 2: add FreeRDP 3

`src-tauri/build.rs` locates FreeRDP with `pkg-config` (`freerdp-client3`) and compiles
`native/freerdp_bridge.c` with the `cc` crate. On Windows, options:

1. **vcpkg** (recommended with the MSVC toolchain): install `freerdp` from vcpkg, then make
   `pkg-config` resolvable: install `pkgconf` from vcpkg too, and point `PKG_CONFIG_PATH` at
   `<vcpkg>/installed/x64-windows/lib/pkgconfig`. The crate `pkg-config` also needs the
   `pkg-config`/`pkgconf` executable on `PATH` (or `PKG_CONFIG` set to it).
2. **Build FreeRDP from source** with CMake and MSVC, then provide the `.pc` files the same way.
3. **MSYS2** has a FreeRDP package, but it is MinGW; it will not link with an MSVC-built Rust
   target. Only usable together with the `x86_64-pc-windows-gnu` Rust toolchain, which Tauri does
   not recommend.

Then build with the default features:

```powershell
npm run tauri dev
```

Things that may need changes in the repository:

- `build.rs`: if `pkg-config` is a problem on Windows, add a `FREERDP_DIR` fallback that sets the
  include and lib paths directly (`cargo:rustc-link-search`, `cargo:rustc-link-lib=freerdp-client3`
  etc.). Keep the pkg-config path for Linux.
- The bridge is written against the Linux build of FreeRDP 3.32; check that the WinPR headers and
  `CRITICAL_SECTION` usage compile with MSVC (they should, WinPR mirrors Win32).
- The FreeRDP DLLs must be next to `iruka.exe` at runtime (copy from vcpkg `bin`), and the Tauri
  bundle configuration needs them listed under `bundle.resources` for an installer.
- Audio: `/sound` and `/microphone` use FreeRDP's Windows audio backends; verify.

## Step 3: record the result

- Update this file (and `windows-client_JA.md`) with the exact commands that worked and any
  changes made.
- Add anything FreeRDP- or Windows-specific that does not work to KNOWN_ISSUES.md.
- Tick "Windows build of the client" in TODO.md when done.
