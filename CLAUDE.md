# Iruka — notes for Claude Code

Read this first in every session, on every machine. It carries the project conventions and the
current hand-off, because Claude Code's per-machine memory does not travel with the repository.

## What this is

A Tauri 2 + React/TypeScript + Rust desktop app that watches many PCs at once: SSH consoles
(xterm.js over a local PTY) and RDP desktops (FreeRDP 3 through a C bridge, IronRDP as fallback)
as live thumbnails. See README.md, docs/code-notes.md (architecture and known weak spots),
KNOWN_ISSUES.md and TODO.md.

## Current hand-off (keep this section up to date at the end of each session)

- **2026-10-16: the Windows client works** (development build, FreeRDP 3.32.1 from vcpkg, connected
  to GNOME Remote Desktop). Procedure: docs/windows-client.md; history: docs/windows-client-log.md.
  On the Windows machine Claude Code runs in WSL and drives the build through `powershell.exe`, with
  the clone at `C:\Users\tosihide\Foundry\Iruka` and the environment in
  `C:\Users\tosihide\Foundry\iruka-env.ps1` (see "Developing from WSL" in that doc).
- **Next**: Windows target works with FreeRDP (NLA, audio, microphone, clipboard). Left: IronRDP to
  Windows, the right Alt toggle, fullscreen, the memory comparison with Linux, and an installer. Keep appending to docs/windows-client-log.md.
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
