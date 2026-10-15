*日本語版: [windows-client_JA.md](windows-client_JA.md)*

# Running Iruka on Windows (client side)

Status: **not tried yet** (written 2026-10-15 from the repository, before the first attempt).
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
npm run tauri dev -- --no-default-features --features ironrdp
```

Expected: the window opens, "+ Console" opens a PowerShell/cmd console (portable-pty uses ConPTY),
"+ SSH" types the ssh command, and "+ RDP" with Backend "IronRDP" connects to a Windows target
(no audio / microphone / clipboard, and GNOME Remote Desktop targets are refused — IronRDP has no
RDPGFX; see KNOWN_ISSUES.md).

Things to check on Windows specifically:

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
