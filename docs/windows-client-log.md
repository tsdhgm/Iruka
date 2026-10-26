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

### Audio test (Ubuntu, Audio and Microphone on, two connections)

- Restarted with `OPENSSL_MODULES` set: the md4 / rc4 warnings are **gone**.
- Microphone: the local microphone reaches the remote. OK.
- Audio playback: the sound kept playing **on the remote**, not locally. The log has no rdpsnd lines
  at all this time, so the backend in use is unknown. (The earlier "Loaded fake backend for rdpsnd" was
  with Audio off, where Iruka passes `/audio-mode:2`; that is expected.)
- Not yet known whether this is Windows-specific: audio against GNOME Remote Desktop has never been
  checked from the Linux client either (TODO). vcpkg's FreeRDP is built with `WITH_WINMM=ON`.

### Windows target (FreeRDP)

- Connected to a Windows target at 3840×2160 through NLA, so NTLM works with `OPENSSL_MODULES` set.
  One attempt ended in `ERRCONNECT_LOGON_FAILURE` (the server rejected the logon, presumably a
  mistyped password); the next one connected.
- Audio is played locally, the microphone reaches the remote, the clipboard works in both directions.
- **Correction to the Ubuntu audio test above**: the FreeRDP log lines arrived late (the log is
  buffered); once they showed up, both Ubuntu sessions had `Loaded winmm backend for rdpsnd`
  (static and dynamic) and `Loaded winmm backend for audin`. The client side is fine, so the sound
  staying on the Ubuntu side is probably GNOME Remote Desktop behaviour, not a Windows client issue.
- Memory (`iruka_mem` used_mb; the Linux comparison is in docs/code-notes.md "Memory model"): 393 with no session; about 760–780 with
  one 1920×1080 Ubuntu session; about 1,010 after that session was closed (not returned);
  about 1,580–1,630 with one 3840×2160 Windows session.

### Windows target (IronRDP) and the remaining UI checks

- IronRDP → Windows: connected.
- Audio playback and microphone do not work through IronRDP. Expected: Iruka only wires audio,
  microphone, Low memory and clipboard for FreeRDP (README). The user's view: IronRDP itself is still
  maturing; labelling it "experimental" would be fair.
- Right Alt view toggle: works (the Japanese keyboard layout here; AltGr layouts not tried).
- Fullscreen and the drop-down toolbar at the top centre: work.

### Portable zip (for the user's own use)

- `src-tauri/src/lib.rs`: on Windows, set `OPENSSL_MODULES` to the exe folder at startup when
  `legacy.dll` is there and the variable is unset.
- Copying the edited `lib.rs` into the Windows clone made the running `tauri dev` rebuild and restart
  Iruka, dropping the open sessions. → Stop `tauri dev` before touching the Windows clone.
- `tauri.cmd build --no-bundle`: 9 min 50 s. Zip assembled under `C:\Users\tosihide\Foundry\dist`.
- Smoke test: started from a PowerShell without the vcpkg folders on PATH: the window opens
  (the DLLs next to the exe are found).
- The user copied the zip to `C:\Tmp`, unpacked it and started `iruka.exe` from there: no warning
  (the zip was made on this PC, so it carries no Mark of the Web), connected to the Windows target
  through NLA, and audio played locally. So the startup `OPENSSL_MODULES` setting works without any
  environment setup.

### SignPath Foundation (free signing for open source), checked against its terms

- Requires an OSI licence for every component, an actively maintained and already released project,
  builds verifiably from the repository (CI), MFA for every team member, defined roles (authors,
  reviewers, approvers), a "Code signing policy" section on the project page, and manual approval of
  every release. The publisher shown by Windows is "SignPath Foundation".
- No minimum user count is stated, but for executable programs it requires "a certain verifiable
  reputation", checked by people at the first review, and acceptance is at its discretion.
  A newly published tool used by one person would most likely not pass yet.

### Summary written

- [windows-client.md](windows-client.md) rewritten as the procedure that worked.

## 2026-10-26: native PowerShell setup

### Environment

- Same goal on a fresh Windows 11 Pro (build 26200), this time with Claude Code for Windows running
  in PowerShell instead of WSL. The owner had installed Git for Windows, Node 26.12, rustup (stable
  MSVC) and Visual Studio Community 2026 (18.11) with the C++ workload, and cloned to
  `C:\Users\tosihide\Iruka`.
- Missing: vcpkg, FreeRDP, the environment script, `node_modules`.

### Steps

- vcpkg cloned to `C:\Users\tosihide\Foundry\vcpkg` (same place as before, so the docs' paths stay)
  and bootstrapped (vcpkg tool 2026-09-26).
- `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"`: 32 min in total (vcpkg
  fetched its own Strawberry Perl, NASM and jom; nothing else to install). FreeRDP is now 3.32.2.
- `C:\Users\tosihide\Foundry\iruka-env.ps1` recreated with the docs' contents.
- `npm install`: npm 11 warns that esbuild's postinstall is "not yet covered by allowScripts" and
  skips it; harmless, `tsc` and `npm run build` pass.
- VS 2026 works: `cargo build` with FreeRDP + IronRDP passes (IronRDP-only first build 8.5 min).
- `cargo test`: `rdp::tests::detects_own_addresses` failed on `is_local_host("", 3389)`. Windows
  resolves an empty name to the machine's own addresses, so an empty host field would have been
  reported as "this PC". Fixed in `src-tauri/src/rdp/mod.rs` (empty host is never local).
- The keyring round trip (`cargo test -- --ignored credentials`) passes against the Windows
  Credential Manager.
- docs/windows-client.md: "Two ways to develop" (native PowerShell and from WSL) added.
### Workset restore right after launch failed (fixed)

- Restoring a workset (6 RDP + 5 SSH) right after launch: every RDP session failed within about
  70 ms with `getaddrinfo(10.0.1.112) failed` → `ERRCONNECT_DNS_NAME_NOT_FOUND`, although the host is
  an IP address. Opening the same profiles one by one from "Saved" worked, which first looked like
  load-related TCP failures.
- Cause: on Windows every Winsock call fails until the process has called `WSAStartup`, and FreeRDP
  leaves that to the application (wfreerdp does it in its `main`). A manual connect first runs the
  "is this PC" check (`rdp_is_self`), whose Rust `std::net` call starts Winsock for the whole
  process; a restore skips that check.
- Fix: `iruka_rdp_new` in `native/freerdp_bridge.c` calls `WSAStartup(2.2)` on Windows (reference
  counted, so once per session is fine). Including `<winsock2.h>` before the FreeRDP headers broke
  `freerdp/rail.h` (C2059); `<winpr/winsock.h>` after them works. Verified: all 6 RDP sessions
  restored right after launch.
- Also added the same day: a memory readout in the toolbar and the Print Screen button moved to the
  far left (README).
### Smart App Control, release build and portable zip

- With Smart App Control still on, the release build failed: `error[E0463]: can't find crate for
  asn1_rs_derive`. Event Viewer → CodeIntegrity → Operational showed events 3033/3077: `rustc.exe`
  was refused loading the freshly built proc-macro DLL `asn1_rs_derive-….dll` ("did not meet the
  Enterprise signing level requirements"). Earlier the same morning the debug `iruka.exe` had been
  blocked first and then ran; the verdicts come from a cloud reputation service and vary. The owner
  turned Smart App Control off; the release build then passed (10 min 51 s).
- `scripts/make-zip.ps1` added (stages the release exe, the 8 vcpkg DLLs, LICENSE, the FreeRDP and
  OpenSSL copyright files and a README, then zips): `iruka-0.1.0-windows-x64.zip`, 9.7 MB, 27 MB
  unpacked, copied to `C:\Users\tosihide\Foundry\dist`. A `dumpbin /dependents` walk confirmed every
  non-system DLL is bundled. The owner unpacked it elsewhere and it runs.

### Seen in the debug build with 6 × 3840×2160 RDP

- About 7 GB for Iruka as a whole; a whole-window freeze of about 10 s while one remote kept sending
  full 4K frames: `copy_ms` 220–380 ms per 32 MB frame (unoptimised debug code), about 1 s from send to
  the WebView (`lag_ms_max`), up to 9.6 s during the freeze; the 5 s frame-ack timeout fired
  repeatedly. To repeat with the release build. Memory questions that came out of it:
  [memory-reduction.md](memory-reduction.md).
## 2026-10-26 (evening): an 8 GB Windows laptop

- Machine: Dell Inspiron 13-5378 (i5-7200U, 2 cores / 4 threads, 7.9 GiB), Windows 11 Pro 24H2
  build 26100, WebView2 155, Smart App Control off. Not the ThinkPad of the Ubuntu half. VS Community
  2026 C++ tools, Rust 1.99.1 and Node 26.12.1 were already installed, and so was the clone with
  `node_modules`; vcpkg and `iruka-env.ps1` were set up fresh.
- `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"`: 44.9 min (OpenSSL alone
  36 min, FreeRDP 6 min). vcpkg now gives **FreeRDP 3.32.2** (3.32.1 before). The slow OpenSSL build
  is possibly Kaspersky (`avp`) scanning every new file; not verified.
- `tauri build --no-bundle`: 14.2 min (13 min 58 s for cargo). `scripts/make-zip.ps1` gives the same
  9.7 MB zip (27.0 MB unpacked), unpacked to `C:\Users\tosihide\Foundry\dist`; it starts from there
  (about 290–370 MB with no session).
- The owner decided not to check Windows 10 at all (end of support).
- Before the measurement, at idle: about 2.3–2.6 GB available, with Chrome, Kaspersky and Dell
  SupportAssist running (Dropbox closed). The page file was system managed (3.3 GB, commit limit
  11.4 GB); the owner's 24–32 GB setting had not taken effect, so the session stopped for a reboot.
  A sampler (`C:\Users\tosihide\Foundry\memlog.ps1`, outside the repo) writes Iruka + WebView2 tree,
  Chrome, available memory, commit and page-file use every 5 s into `memlog.csv`.
- After the reboot: page file 24–32 GB, commit limit 32.6 GB.

### Six 3840×2160 sessions on 7.9 GiB, release build from the unpacked zip

The owner opened the sessions one by one by hand (the profiles connect at the local 4K size, not
1920×1080 as planned). Private bytes add up the commit Iruka actually holds; the working set is what
Windows lets stay in RAM.

| Sessions | Chrome closed: iruka.exe private / WebView2 private / `used_mb` | Chrome open (Prime Video playing): same / page file in use |
| --- | --- | --- |
| 0 | 7 MB / 160 MB / 400 | 7 MB / 160 MB / 384; Chrome 3.7 GB working set, 0.75 GB available |
| 1 | 540 MB / 650 MB / 1,500–1,600 | 540 MB / 600–720 MB / 1,100; 70 MB |
| 2 | 1.18 GB / 980 MB / 2,050–2,110 | 1.05–1.37 GB / 850–1,010 MB / 1,940; 540 MB |
| 3 | 1.56 GB / 1.02 GB / 2,650–2,720 | 1.56–1.86 GB / 1.0–1.24 GB / 1,940; 537 MB |
| 4 | 2.07 GB / 1.13 GB / 2,560–2,650 | 2.07–2.34 GB / 1.0–1.33 GB / 1,730; 528 MB |
| 5 | 2.6 GB / 1.27–1.39 GB / 2,480–2,540 | 2.58–2.79 GB / 1.19–1.53 GB / 1,720; 910 MB |
| 6 | 3.1–3.4 GB / 1.35–1.55 GB / 2,400–2,700 | 3.1–3.4 GB / 1.15–1.48 GB / 1,720; 884 MB |

- All six run in both cases and nothing crashed. The first 4K session costs about 1.2 GB (as on the
  32 GB box), every further one about 0.5–0.6 GB of private bytes, close to Linux's 525–551 MB.
  Iruka holds about 4.5–4.9 GB in all with six.
- **Memory is not the limit.** Without Chrome, from the fourth session Windows trims Iruka's working
  set (iruka.exe 1.35 → 0.5 GB) into the compressed store (Memory Compression 335 → 610 MB); the page
  file stays at 40 MB and commit at 11 GB of 32.6 GB. With Chrome, Windows trims both Chrome
  (3.7 → 1.3 GB working set) and Iruka, the page file grows to about 0.9 GB (most of it when the second
  and the fifth session connected), commit reaches 14.3 GB. The 24–32 GB page file is far more than
  needed.
- **The 2-core CPU is.** The owner: "jerky and slow to respond, but does not crash" with six. Without
  Chrome, two whole-window stalls (all six sessions' 5 s frame-ack timeouts at the same second, 20:00:04
  and 20:00:55) and `lag_ms_max` averaging 1.0 s (max 2.2 s); with Chrome, 44 timeouts, recurring every
  5 s for four to five sessions at once while the thumbnails kept drawing, `lag_ms_max` averaging 2.2 s
  (max 4.0 s). Up to five sessions with Chrome had no timeout at all. The 5 s sampler stretched to
  8–12 s. CPU use itself was not recorded.
- Chrome's Prime Video played smoothly beside three sessions and paused for a moment when the fifth
  connected (the page file grew by 380 MB at that point). It also pauses while Iruka is full screen,
  which is Chrome hiding an occluded page, not Iruka.
- Closing the window with six sessions open: clean exit (code 0) both times, Iruka's WebView2
  processes gone within seconds. The Linux crash on close (KNOWN_ISSUES.md) does not happen here.
- Windows Error Reporting logged `RADAR_PRE_LEAK_64` (the leak detector's report on a process whose
  commit keeps growing; not a crash) for iruka.exe at 20:04 and for msedgewebview2.exe at 20:08.
- The memory model learns from the working set on Windows (`sysinfo`'s `memory()` is `WorkingSetSize`),
  so under pressure it reads low: the learned scale fell from 1.83 to 1.65 during the Chrome-less run.
  The second run opened its first session within the 15 s warm-up and learned nothing (TODO.md).
- No crash, no TDR: the owner thought a graphics-driver error had appeared over Claude Code during
  the Chrome run; the System log has no display-driver event (4101) for that time.

### The portable zip never loaded OpenSSL's legacy provider (fixed)

- Both runs logged `OpenSSL LEGACY provider failed to load, no md4 support available!` and the md4 /
  rc4 warnings on connect, although `legacy.dll` sits next to `iruka.exe` and Iruka sets
  `OPENSSL_MODULES` at startup. The Windows target still connected (not through NTLM, apparently).
- With the variable set before launch the warnings were gone, so the startup code was at fault:
  `std::env::set_var` changes the process environment only, while OpenSSL reads the C runtime's copy
  with `getenv`. Fixed with `_wputenv_s` (updates both); rebuilt in 2 min 43 s; from the unpacked
  folder without the variable no legacy / md4 / rc4 line, to both a Windows and an Ubuntu target.
  KNOWN_ISSUES.md "vcpkg's OpenSSL does not find its legacy provider".
