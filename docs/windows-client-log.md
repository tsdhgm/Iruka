*日本語版: [windows-client-log_JA.md](windows-client-log_JA.md)*

# Windows client work log (trial and error)

A chronological record of getting Iruka to run as a client on Windows, dead ends included.
The cleaned-up procedure is in [windows-client.md](windows-client.md).

## 2026-10-16

### Environment

- Windows 11 24H2 (build 26100). The development environment had just moved to Windows, with only
  WSL2 and Claude Code inside it installed.
- Already on the Windows side: Node.js v22.17.1, Visual Studio Community 2022 / 2019 and Build Tools
  2019 (with C++ tools), WebView2 155, OpenSSH `ssh.exe`, winget.
- Missing: Rust, Git for Windows, pkg-config, vcpkg.

### Approach: edit in WSL, build natively on Windows

- A build inside WSL produces a Linux binary that only runs under WSLg, which does not test the
  Windows client.
- So Windows is driven from WSL's bash through `powershell.exe` / `cmd.exe`.
- The source lives on the Windows file system (building across `\\wsl$` is slow and fragile).

### Step 1: IronRDP-only build

1. Rust: `winget install --id Rustlang.Rustup -e`; no admin rights needed (per user). Installed
   stable `x86_64-pc-windows-msvc`, cargo 1.99.1.
2. Windows processes started from WSL inherit the PATH from when WSL started, so `.cargo\bin` was
   not on it. `C:\Users\tosihide\Foundry\iruka-env.ps1` now prepends it and changes to the clone.
3. To avoid installing Git for Windows, the repository was cloned with WSL's git into
   `/mnt/c/Users/tosihide/Foundry/Iruka`, with two remotes: `wsl` (the WSL repository) and `origin`
   (GitHub).
4. `npm.cmd install`: OK.
5. `npm.cmd run build`, then `cargo build --no-default-features --features ironrdp`: OK in 7 min 08 s,
   4 warnings (FreeRDP-only code becomes dead).
6. Launch **failure 1**: the documented `npm run tauri dev -- --no-default-features --features ironrdp`
   gives `error: unexpected argument '--no-default-features'`. npm strips the `--` and the flag
   reaches the Tauri CLI.
7. Launch **success**: `.\node_modules\.bin\tauri.cmd dev --features ironrdp -- --no-default-features`
   (cargo flags after the second `--`). The "Iruka" window opened; memory right after start was
   about 390 MB (`iruka_mem` used_mb).

### Step 1 checks (done by the user)

- **"+ Console"**: opened WSL bash.
  - Cause: `pty.rs` starts `$SHELL`, else `bash`. Windows has no `$SHELL`, and `bash` resolves to
    `C:\Windows\System32\bash.exe`, the WSL launcher. The working directory was not the home folder
    either (`$HOME` unset).
  - Fix: on Windows fall back to `powershell.exe`, and to `%USERPROFILE%` for home. `tauri dev`
    noticed the change and rebuilt automatically (25 s); PowerShell confirmed.
  - The user's view: WSL bash is fine for them, but others may want to pick a profile → TODO.
- **"+ SSH"**: typed `ssh user@host` and connected.
- **"+ RDP" with IronRDP to Ubuntu**: `Connection error (IronRDP): Connection failed: Session start:
  … decode error … other (received disconnect provider ultimatum)`.
  - Expected: IronRDP has no RDPGFX, so GNOME Remote Desktop disconnects. Not Windows-specific (same on
    Linux).
  - The built-in Windows Remote Desktop client connects to the same target.
- **IronRDP to Windows**: postponed until a separate Windows target is set up.
- Commit `8db57e6` (the `pty.rs` fix, step 1 results, TODO).

### Step 2: FreeRDP 3 through vcpkg

- No official Windows distribution of the FreeRDP 3 development files (headers, `.lib`, `.pc`), so
  build it with vcpkg.
- vcpkg's `freerdp` port is **3.32.1**, the same version used on Linux. Features: `client`, `ffmpeg`,
  `av1`, `server`, `urbdrc`, `winpr-tools`, `x11` (`x11` is not available on Windows). Start with
  `client` only.
- Cloned with WSL's git into `C:\Users\tosihide\Foundry\vcpkg`, then
  `bootstrap-vcpkg.bat -disableMetrics` (vcpkg 2026-09-26).
- `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"`: 9 packages, 20 min in total
  (FreeRDP itself 4.6 min), no errors. `lib\pkgconfig` has `freerdp-client3.pc` and friends, `bin` has
  `freerdp3.dll` / `freerdp-client3.dll` / `winpr3.dll` and the OpenSSL / zlib / cJSON DLLs, and
  `tools\pkgconf\pkgconf.exe` is there.
- Added to `iruka-env.ps1`: vcpkg's `bin` (runtime DLLs) and `tools\pkgconf` on PATH,
  `PKG_CONFIG=...\pkgconf.exe`, `PKG_CONFIG_PATH=...\lib\pkgconfig`.
  `pkgconf --cflags --libs freerdp-client3` resolves correctly.
- Build **failure 2**: `cargo build` (default features) stopped with
  `failed to remove file ...\iruka.exe`. Stopping step 1's `tauri dev` on the WSL side had left the
  Windows processes (tauri.js / cargo / vite / iruka.exe) running, locking the exe. Killed with
  `taskkill /T /F`.
  → Stopping a job on the WSL side does not end the Windows processes it started.
- Build **success**: no change to `build.rs` or `freerdp_bridge.c`; the pkg-config path works as is
  with MSVC (25 s; the C compiler warnings were not captured).
- Launch **success**: `.\node_modules\.bin\tauri.cmd dev` (default features = freerdp,ironrdp). The
  DLLs load because vcpkg's `bin` is on PATH (not yet copied next to the exe).

### Step 2 checks (done by the user)

- FreeRDP → Ubuntu (GNOME Remote Desktop): **connected**.
- Clipboard: copy and paste in both directions OK.
- Grid view, Tab to move between sessions, select to enlarge: OK.
- Memory: `iruka_mem` used_mb about 1024 with two sessions (pixels = 2 × 1920×1080), baseline 388.

### Found in the log: md4 / rc4 missing

- FreeRDP's warnings on connect: `md4: NTLM support not available`,
  `rc4: … NTLM and autoreconnect cookies will not work`, `rc4: RDP licensing and RDP security will not work`.
- Suspected the OpenSSL 3 legacy provider. `strings` on vcpkg's `libcrypto-3-x64.dll` shows
  `MODULESDIR: "C:\Program Files\OpenSSL\bin"`, while `legacy.dll` is in vcpkg's `bin`. Confirmed.
- Added `OPENSSL_MODULES=<vcpkg>\bin` to `iruka-env.ps1`. Whether the warnings go away, and whether
  NTLM to a Windows target works, is not checked yet. Recorded in KNOWN_ISSUES.md.
- Other warnings were the expected ones (`/p` on the command line, `/cert:ignore`).

### Summary written

- [windows-client.md](windows-client.md) rewritten as the procedure that worked.
