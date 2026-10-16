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
- `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"`: 9 packages. The dependencies
  (OpenSSL, zlib, cJSON, …) built without problems; FreeRDP itself is building.

(to be continued)
