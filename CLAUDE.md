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
- **Next (the user is moving back to Ubuntu)**: a `.deb` or tarball/AppImage for the user's own use;
  compare memory use with the Windows figures (about 1.6 GB `used_mb` for one 4K session, not
  returned after closing); Ubuntu audio playback staying on the remote (compare with the Linux client).
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

`scripts/install-dev-desktop.sh` registers the dev build's icon with a Linux desktop (optional).
