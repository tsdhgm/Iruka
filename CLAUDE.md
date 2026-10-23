# Iruka — notes for Claude Code

Read this first in every session, on every machine. It carries the project conventions and the
current hand-off, because Claude Code's per-machine memory does not travel with the repository.

## What this is

A Tauri 2 + React/TypeScript + Rust desktop app that watches many PCs at once: SSH consoles
(xterm.js over a local PTY) and RDP desktops (FreeRDP 3 through a C bridge, IronRDP as fallback)
as live thumbnails. See README.md, docs/code-notes.md (architecture and known weak spots),
KNOWN_ISSUES.md and TODO.md.

## Current hand-off (keep this section up to date at the end of each session)

- **2026-10-16: the Windows client works** (FreeRDP 3.32.1 from vcpkg, IronRDP now labelled
  experimental). Checked against Ubuntu GNOME Remote Desktop and a Windows target: NLA, audio,
  microphone, clipboard, right Alt, fullscreen. A portable zip (unsigned, for the user's own use) is
  built and verified; the installer is postponed (distribution and signing notes in TODO.md).
  Procedure: docs/windows-client.md; history with the dead ends: docs/windows-client-log.md (keep
  appending to it).
- **Windows machine setup**: Claude Code runs in WSL and drives the build through `powershell.exe`.
  Clone at `C:\Users\tosihide\Foundry\Iruka` (remotes `wsl` = the WSL repository, `origin` = GitHub;
  commit in WSL, then `git pull wsl main` there), vcpkg at `C:\Users\tosihide\Foundry\vcpkg`,
  environment in `C:\Users\tosihide\Foundry\iruka-env.ps1`, zips in `C:\Users\tosihide\Foundry\dist`.
  Stop `tauri dev` before touching the Windows clone. See "Developing from WSL" in docs/windows-client.md.
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
- The deb from `scripts/make-deb.sh` is installed on the Ubuntu box (`/usr/bin/iruka`, dolphin
  icon verified; rebuilt and reinstalled 2026-10-23 with the cursor feature, via `sudo dpkg -i`
  because the version is still 0.1.0 and `apt install` does not replace a same-version package);
  the dev desktop entry was removed since the deb's entry also matches dev builds.
- Tested so far: clients on Ubuntu 26.04 LTS and Windows 11 24H2; targets Windows 11 Pro, Ubuntu
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
  dedicated monitoring box. Keep per-session memory in mind for any frame-path change.

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
