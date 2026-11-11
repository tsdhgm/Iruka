# Iruka — notes for Claude Code

Read this first in every session, on every machine. It carries the project conventions and the
current hand-off, because Claude Code's per-machine memory does not travel with the repository.

## What this is

A Tauri 2 + React/TypeScript + Rust desktop app that watches many PCs at once: SSH consoles
(xterm.js over a local PTY) and RDP desktops (FreeRDP 3 through a C bridge, IronRDP as fallback)
as live thumbnails. **End goal (owner, 2026-10-24): worksets**, i.e. save the set of open sessions
and restore them all after a restart (TODO.md "Goal: worksets"; needs the OS-keyring credential
store). Windows client mandatory, macOS desirable. See README.md, docs/code-notes.md (architecture and known weak spots),
KNOWN_ISSUES.md and TODO.md.

## Current hand-off (keep this section up to date at the end of each session)

- **2026-10-16: the Windows client works** (FreeRDP 3.32.1 from vcpkg, IronRDP now labelled
  experimental). Checked against Ubuntu GNOME Remote Desktop and a Windows target: NLA, audio,
  microphone, clipboard, right Alt, fullscreen. A portable zip (unsigned, for the user's own use) is
  built and verified; the installer is postponed (distribution and signing notes in TODO.md).
  Procedure: docs/windows-client.md; history with the dead ends: docs/windows-client-log.md (keep
  appending to it).
- **Windows machine setup**: two ways, both building natively (docs/windows-client.md "Two ways to
  develop"). **Native** (from 2026-10-26): Claude Code for Windows in PowerShell, clone at
  `C:\Users\tosihide\Foundry\iruka` (moved there from `C:\Users\tosihide\Iruka` after 2026-10-26; Git
  for Windows, remote `origin` = GitHub only), VS Community 2026 C++ tools, Node 26. **From WSL**
  (2026-10-16, not set up on the current Windows install): Claude Code in WSL drives the build
  through `powershell.exe`; it used a clone at `C:\Users\tosihide\Foundry\Iruka`, which is the
  same folder as the native clone now (Windows paths ignore case), so a WSL setup would work on
  that clone from `/mnt/c/Users/tosihide/Foundry/iruka`, never building at the same time as the
  native side; back then it had a second remote `wsl` = the WSL repository (commit in WSL, then
  `git pull wsl main` there); see "Developing from WSL". Shared: vcpkg at
  `C:\Users\tosihide\Foundry\vcpkg`, environment in `C:\Users\tosihide\Foundry\iruka-env.ps1`
  (dot-source it before building), zips in `C:\Users\tosihide\Foundry\dist`. Stop `tauri dev` before
  touching a clone from the other side.
- **2026-10-16, back on Ubuntu: Linux packages done.** `scripts/make-deb.sh` (deb depending on
  Ubuntu's `libfreerdp-client3-3`; desktop template `src-tauri/linux/iruka.desktop` adds Categories
  and keeps `StartupWMClass=iruka`: the Wayland app id is the binary name, the identifier only
  travels as the GtkApplication id) and
  `scripts/make-tarball.sh` (release binary with RPATH `$ORIGIN/lib`, FreeRDP 3 libraries in `lib/`,
  `check-deps.sh` with a soname -> package table, desktop-entry script). Release binaries are stripped
  (`[profile.release] strip = true`). Only GNOME (Wayland) is tested; KDE is in TODO.md.
- **2026-10-23: the cursor over the remote screen follows the remote's shape** (FreeRDP pointer
  updates → CSS cursor; docs/code-notes.md "Cursor shape"). Verified on a Windows target.
- **2026-10-23: memory comparison done** (table in docs/code-notes.md "Memory model"). One
  3840×2160 FreeRDP session costs about 550 MB over the baseline on Linux against about 1.2 GB on
  Windows. Both clients keep memory after a session closes; on Linux about 600 MB stayed, almost
  all of it in fully resident 64 MB glibc malloc arenas of the main process, growing with each
  open/close cycle.
- The kept-memory follow-up (`malloc_trim(0)` at session end or `M_ARENA_MAX`, re-measure, heaptrack)
  is **deferred by the owner** to a later occasion; it stays in TODO.md. **Next:** Ubuntu audio
  playback staying on the remote (compare with the Linux client).
- **2026-10-23: Iruka gets SIGKILLed under load (seen with OBS capturing the 4K display).** Cause
  found with gdb + bpftrace: WebKitGTK makes its IPC `ReceiveQueue` threads real-time via RealtimeKit
  with `RLIMIT_RTTIME` 200 ms, and the kernel kills the process when one runs that long without
  blocking (KNOWN_ISSUES.md; full story and the Remmina design comparison in docs/realtime-kill.md).
  Owner's decision: recorded only, no workaround in code; the candidate stays in TODO.md. The
  no-code workaround (start with `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent`, so WebKit cannot
  reach RealtimeKit) is verified in real use with OBS (no kill, but slower response); on the Ubuntu
  box it lives outside the repo as `~/.local/bin/iruka-no-realtime` plus a second dock entry
  "Iruka (no realtime)". The owner uses it only for OBS recordings.
- **2026-10-24: Linux diagnostics kit** in `scripts/diag/` (exit-status wrapper `iruka-logged` behind
  both dock entries, `exit.log` + `journalctl --user -t iruka-exit`; bpftrace `iruka-kill-watch`
  system service), how-to in docs/linux-diagnostics.md, trial-and-error log in
  docs/linux-diagnostics-log.md. Installed on the Ubuntu box (the kill-watch service needs the owner's
  sudo). **Found by accident: a second start of Iruka kills the running one** (Tauri setup panic via
  GtkApplication activate; KNOWN_ISSUES.md, fix candidates in TODO.md). Never start a test Iruka
  while the owner's instance runs: `pgrep -x iruka` first.
- **2026-10-24: passwords in the OS credential store and worksets implemented** (`keyring` 4 crate,
  `src-tauri/src/credentials.rs`; `src/worksets.ts`, `WorksetSection`, `RestoreReportModal`;
  `rdp_memory_budget`). Restore starts sessions one at a time and only as many RDP sessions as the
  memory estimate allows (owner's premise). Verified: cargo tests incl. a real GNOME Keyring round
  trip, tsc, vite build. **In use by the owner since 2026-10-24** (6 RDP + 5 SSH, saved and
  restored). Open follow-ups in TODO.md "Goal: worksets".
- **2026-10-24 (evening), the Ubuntu system moved to a portable USB SSD** (hostname `linux-ssd`;
  the whole installation, home directory and the repo at `/_export/shared/Local/Iruka` are on that
  disk, so it boots on different hardware: 60 GB RAM / 16 CPUs on 2026-10-24, 16 GB / 8 CPUs on
  2026-10-25, which matches the 16 GB monitoring-box budget). Dev environment reinstalled on it:
  rustup stable, Tauri `-dev` packages, `freerdp3-dev`, `patchelf`; nothing per machine. Features added the same evening, all
  pushed: SSH "Save password" (typed once at ssh's `password:` prompt, `passwordPromptAnswerer` in
  `src/ptySession.ts`); toolbar "Scaled" (fit the RDP screen, `iruka.scaled`); toolbar Print Screen
  button (⎙; the local GNOME keeps the key, KNOWN_ISSUES.md, owner declined a keyboard grab);
  F11 / Esc toggle full screen when the focus is outside a session. The owner runs the repository's
  release build with `run.sh` while testing; the deb is also installed and the two dock entries are
  restored; the `iruka-kill-watch` service is **not** installed on this box (needs the owner's sudo).
  With 16 CPUs glibc allows 128 malloc arenas: 143 arena-sized mappings, 1.3 GB resident, were seen
  with 6 RDP sessions (3.2 GB main process), the same mechanism as the kept-memory item.
- **2026-10-25: frame path and link health.** The kernel OOM killer took the WebKit web process on
  the 16 GB box under load (six 4K sessions, a YouTube video, and a terminal spinner on an "idle"
  remote: KNOWN_ISSUES.md "A terminal spinner…"); fixed with end-to-end back-pressure (`FrameGate`,
  `rdp_frame_done`, docs/code-notes.md "Back-pressure, end to end"; commit ea4e801). The owner's
  first test of that build ended with "The connection transport layer failed" on one session: a
  Wi-Fi stall longer than FreeRDP's 9 s `TCP_USER_TIMEOUT`, not the gate (KNOWN_ISSUES.md "A session
  drops with…"). Done the same evening: `/timeout:60000`, a stall warning over the screen after 9 s
  from `TCP_INFO` (Linux only), automatic reconnect up to 10 times 5 s apart with a message
  (docs/code-notes.md "Link health and reconnect"; commit 4c0796c). **Not yet exercised on a real
  link drop**; test recipe: on a remote, `sudo iptables -I INPUT -s <client ip> -j DROP; sleep 20
  (or 75); sudo iptables -D INPUT -s <client ip> -j DROP`. The back-pressure build itself has had
  only that one short run (no `frame not acknowledged in time` / `lag_ms_max` numbers yet).
  (The plan for 2026-10-26 was to test both from the USB SSD on the Windows hardware; the day went
  to the native Windows setup instead, see the next item. Both tests are still open.)
- **2026-10-26: native Windows development set up and used** (fresh Windows 11 Pro build 26200,
  32 GB box; docs/windows-client-log.md "2026-10-26"). Smart App Control was on and blocked the
  built `iruka.exe` and even `rustc` loading proc-macro DLLs; the owner turned it **off**
  (KNOWN_ISSUES.md). Fixed: workset restore right after launch failed on Windows (Winsock never
  started: `WSAStartup` now in `iruka_rdp_new`); `is_local_host("")` true on Windows. Added: toolbar
  memory readout (`memory_status`: selected RDP session's estimated share / Iruka / RAM) and the
  Print Screen button moved to the far left; `scripts/make-zip.ps1` (portable zip, verified by the
  owner unpacked elsewhere). Study only, nothing implemented: docs/memory-reduction.md (why
  compression ratio, dropped frames or H.264 do not save memory; candidate levers; the Windows build
  has no H.264). Seen with 6 × 4K RDP in a **debug** build: about 7 GB, a ~10 s whole-window freeze
  while one remote sent full 4K frames (`copy_ms` 220–380 ms, ~1 s per 32 MB frame to the WebView).
  (The 8 GB laptop plan from this day is carried out in the next item.)
- **2026-10-26 (afternoon): the 8 GB laptop, Ubuntu half done.** ThinkPad X1 Carbon 3rd gen
  (i5-5300U, 4 CPUs, 7.1 GiB, 32 GB swap, Ubuntu 26.04.1, kernel 7.0.0-38, GNOME/Wayland); clone at
  `/home/tosihide/Foundry/Repo/Iruka`. Dev environment built from nothing: rustup stable (1.99.1),
  the Tauri `-dev` packages, `freerdp3-dev` 3.32.1, `patchelf`, Node 24.20.0 through nvm.
  `npx tauri build --no-bundle` took 19 min 50 s with `CARGO_BUILD_JOBS=3` (target directory 3.3 GB);
  `cargo test` 8 passed, and the `#[ignore]`d real-GNOME-Keyring round trip passes here too.
  **Six 3840×2160 sessions run fine on 7.1 GiB** (peak 3567–3864 MB over seven runs, 525–551 MB per
  session, the same per-session cost as the 16 GB box). Measurements and what they mean are in
  docs/code-notes.md "Memory model": the restore memory limit fired on real hardware for the first
  time (five of six restored once, all six a few minutes later — it sits right on the boundary, and
  is about 30% more conservative than the measurements); `IRUKA_FAKE_AVAILABLE_MB` turned out to be
  debug-only, so a release build ignores it; the memory model learns nothing in a run that restores
  a workset inside the 15 s warm-up; and only 178 MB stayed after closing all six sessions, against
  about 600 MB on the 16-core box (4 CPUs cap glibc at 32 arenas against 128 — supports the arena
  explanation and `M_ARENA_MAX`). Open follow-ups are in TODO.md. **Two crashes found**, both in
  KNOWN_ISSUES.md and both deferred by the owner to a day of their own: (1) the RealtimeKit SIGKILL
  reproduced **without OBS and without any other load** — killed 42 s into ordinary use with six 4K
  sessions, and the mechanism read straight off `/proc` (`RLIMIT_RTTIME` 160/200 ms, two `SCHED_RR`
  priority-5 `ReceiveQueue` threads in the main process), so on a slow CPU this is an ordinary-use
  problem, not a screen-capture one; (2) a glibc "corrupted double-linked list" crash of
  `WebKitWebProcess` (and once of Iruka itself) within about 2 s of closing the window with sessions
  open — heap corruption, cause not established. **Lesson for the next session**: start Iruka
  through `scripts/diag/iruka-logged`. A bare run of the binary hides the exit status and apport
  ignores unpackaged executables, so two abnormal exits (137 = SIGKILL, 134 = SIGABRT) were first
  misread as clean ones.
- **2026-10-26 (evening): the 8 GB laptop, Windows half done**, on a different machine (Dell
  Inspiron 13-5378, i5-7200U 2 cores / 4 threads, 7.9 GiB, Windows 11 Pro 24H2, 24–32 GB page file;
  Windows 10 dropped by the owner, end of support). vcpkg set up fresh (44.9 min, now **FreeRDP
  3.32.2**), release build 14.2 min, zip in `C:\Users\tosihide\Foundry\dist`. **Six 3840×2160
  sessions run on 7.9 GiB**, with and without Chrome playing Prime Video beside them; nothing crashed,
  and closing the window with six sessions open exits cleanly (code 0; the Linux crash on close does
  not happen on Windows). The first session costs about 1.2 GB, each further one about 0.5–0.6 GB of
  private bytes (close to Linux); Windows absorbs the rest by trimming working sets into the
  compressed store and page file (at most 0.9 GB of page file used). **The limit is the 2-core CPU**:
  "jerky and slow to respond, but does not crash" (owner), 5 s frame-ack timeouts, `lag_ms_max`
  1–4 s. Numbers in docs/windows-client-log.md "2026-10-26 (evening)" and docs/code-notes.md "Memory
  model". New TODO: on Windows the memory model reads the working set, so it learns low under
  pressure. **Fixed**: the portable zip never loaded OpenSSL's legacy provider (md4 / rc4, so no NTLM)
  — `std::env::set_var` did not reach OpenSSL's CRT `getenv`; now `_wputenv_s` in
  `point_openssl_at_exe_dir`, verified to a Windows and an Ubuntu target (KNOWN_ISSUES.md). On this
  machine (outside the repo): `C:\Users\tosihide\Foundry\memlog.ps1` samples memory every 5 s into
  `memlog.csv`; `dist\iruka-fixtest` was the test copy of the fix. No worksets saved here yet.
  Still open: the two Linux crashes above, repeat the 10 s freeze with a release build
  (copy cost vs. WebView2 transfer), and the reconnect and back-pressure tests from 2026-10-25.
- **2026-11-02: another Ubuntu dev machine** (hostname `M5-Pro`, 16 CPUs, 30 GiB, Ubuntu 26.04.1,
  kernel 7.0.0-42; clone at `/home/tosihide/Foundry/Repo/Iruka`, Node 26.13.0 through nvm). The owner
  installed the build environment (Tauri `-dev` packages, `freerdp3-dev`, `patchelf`,
  `libdbus-1-dev`, rustup stable) and reports that it builds. Nothing measured or tested on it yet.
- **2026-11-09: another Windows build machine** (ThinkPad E14 Gen7 AMD, 16 threads, 62 GB, Windows 11
  Pro build 26300; clone at `C:\Users\tosihide\Foundry\Repo\Iruka`, not `Foundry\iruka`). Already
  there: VS Build Tools 18 (C++), Node 24.14.0, Git, Python. Installed per user, no admin needed:
  rustup stable (1.99.1), vcpkg at `C:\Users\tosihide\Foundry\vcpkg` with FreeRDP (12 min),
  `C:\Users\tosihide\Foundry\iruka-env.ps1`. Smart App Control was on and blocked even a hello-world
  exe (os error 4551); the owner turned it **off**. Release build (2 min after pre-compiling the
  dependencies) and `scripts\make-zip.ps1` → `release\iruka-0.1.0-windows-x64.zip` (9.6 MB). The
  owner wants a plain zip with the exe, not an installer. Checked only that the unpacked copy starts
  (window opens, no vcpkg on `PATH`, `OPENSSL_MODULES` unset); no RDP / SSH connection tried yet.
- **2026-11-11: another Ubuntu machine** (hostname `linux-m2sata`, 16 CPUs, 30 GiB, Ubuntu 26.04.1,
  kernel 7.0.0-43; repo at `/_export/shared/Foundry/Repo/Iruka`, Node 24.18.0 through nvm, rustc
  1.98.1, `freerdp3-dev` 3.32.2). The build environment was checked and nothing is missing. Clean
  build (`cargo clean`, `npm ci`, `npx tauri build --no-bundle`): 2 min 58 s, no warnings.
  **Fixed the same day**: "Save password" failed with `NoSession: The session wrapping the secret
  does not exist` after the keyring daemon was replaced under a running Iruka
  (`gnome-keyring-daemon --replace` at 13:45, Iruka started 13:11); `credentials.rs` now reconnects
  to the Secret Service and retries once (docs/code-notes.md). Proven only by the `#[ignore]`d test
  `survives_a_keyring_daemon_restart` on a throw-away session bus; in real use the owner is waiting
  to see whether it comes back (a working reconnect leaves `credential store call failed … reconnecting`
  in the log). The installed deb (0.1.1, version bump not in the repo: it was made on a Windows
  machine and never pushed) does not have the fix. **Version raised to 0.1.2** to tell the fixed build from that
  unknown 0.1.1 (the GitHub release is still `v0.1.0`, Windows zip only);
  `release/iruka_0.1.2_amd64.deb` is built, installing it needs the owner's sudo.
- The deb from `scripts/make-deb.sh` is installed on the Ubuntu box (`/usr/bin/iruka`; installed
  2026-10-24 on the new box with `apt install`; on a box that already has it, reinstalling the same
  version 0.1.0 needs `sudo dpkg -i`, since `apt install` does not replace a same-version package);
  the dev desktop entry was removed since the deb's entry also matches dev builds.
- Tested so far: clients on Ubuntu 26.04 LTS and Windows 11 24H2 (builds 26100 and 26200); targets Windows 11 Pro, Ubuntu
  GNOME Remote Desktop, Apple Silicon Mac running clintcan/macrdp.
- Open items live in TODO.md; do not keep a separate list elsewhere.

## Conventions

- **Git**: commit directly on `main` (pre-1.0, no feature branches). Pass the author explicitly:
  `git -c user.name=tosihide -c user.email=tosihide@acm.org commit …`. End commit messages with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Push after committing when the user
  asks. Never commit `next.sh` (ignored) or session-note files `2026*-*.md` (ignored).
- **Language**: all source comments, UI strings, log and error strings are English. Documentation is
  English-first; every doc has a Japanese twin with the `_JA.md` suffix (README_JA.md,
  KNOWN_ISSUES_JA.md, TODO_JA.md, docs/*_JA.md), each linking to the other at the top. Update both
  when changing one. Talk to the user in Japanese.
- **Problems outside Iruka** (FreeRDP, the OS, GNOME Remote Desktop) are recorded in
  KNOWN_ISSUES.md with the cause and a possible fix, not worked around in code.
- **Debugging aids stay** until the user says debugging is over: the `iruka_perf` / `iruka_mem`
  debug logging enabled by the default filter in `src-tauri/src/lib.rs`, and the in-process `/p:`
  password argument to FreeRDP. Do not propose removing them.
- **IronRDP** is a fallback only; do not invest in it unless asked.
- **Memory budget**: 20+ PCs, each with an SSH console and an RDP session, on a 16 GB (maybe 8 GB)
  dedicated monitoring box; the owner's Windows client box will have 32 GB (2026-10-24). Keep per-session memory in mind for any frame-path change.

## Building and running

```sh
npm install
npm run tauri dev            # Linux: needs freerdp3-dev (Ubuntu), see README.md
IRUKA_LOG=iruka_mem=debug npm run tauri dev   # narrower logging
cd src-tauri && cargo test --no-default-features --features freerdp,ironrdp
npx tsc --noEmit -p tsconfig.json && npm run build
```

`scripts/install-desktop-entry.sh` registers the dev build's icon with a Linux desktop (optional).
`scripts/make-deb.sh` builds the Debian package; `scripts/make-tarball.sh` the self-contained tarball
(release binary + FreeRDP libraries, RPATH `$ORIGIN/lib`). Both land in `release/` (ignored).
