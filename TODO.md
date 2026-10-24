*日本語版: [TODO_JA.md](TODO_JA.md)*

# TODO

Open tasks and things still to verify. Bugs that live outside Iruka (FreeRDP, the OS) are recorded in [KNOWN_ISSUES.md](KNOWN_ISSUES.md), not here. Design-level weak spots are described in [docs/code-notes.md](docs/code-notes.md).

## Goal: worksets (stated by the owner 2026-10-24)

The end state Iruka is heading for: several RDP sessions (and SSH consoles, if feasible) are open;
"save workset" records the current state; after a restart, "restore workset" brings every session
back. The Windows client is mandatory, macOS desirable. The pieces, in order:

- [x] (2026-10-24) Worksets: saved connections in sidebar order plus view and grid columns
  (`src/worksets.ts`); "Last open sessions" is written automatically; the "Worksets" sidebar
  section saves and restores (README "Saved connections", docs/code-notes.md "Credentials and worksets").
- [x] (2026-10-24) Passwords in the OS credential store through the `keyring` crate (Secret Service
  on Linux, Credential Manager on Windows, Keychain on macOS), opt-in per RDP connection ("Save
  password"), default off.
- [x] (2026-10-24) Restore in order, one session at a time (an RDP session is awaited up to 20 s);
  only as many RDP sessions as the memory estimate allows (`rdp_memory_budget`), the rest listed in
  the report. SSH is restored by retyping the `ssh` line (the remote shell state does not come back).
- [ ] Verify the worksets in real use: restore after a restart with several RDP sessions and an
  SSH console; the "memory would run short" path (`IRUKA_FAKE_AVAILABLE_MB` in a dev build); the
  Windows client (Credential Manager; the memory model has not learned Windows figures yet, so the
  first estimates use the Linux-based default and may let too many sessions through).
- [ ] Sessions skipped at restore (memory, no password) and sessions that failed to connect are only
  listed in the report; give them placeholders in the session list that reconnect on click.
- [ ] A dialog before restoring (all / only what fits / cancel) instead of deciding silently, if the
  owner wants the choice; today the premise is "only what fits".
- [ ] SSH: prefer `ssh-agent` keys; Iruka stores no SSH passwords.

## To verify after the 2026-10-13 refactor (App.tsx split, English UI)

A quick check on 2026-10-13 found no problems. Still to be checked more carefully:

- [ ] Connect form: the English labels (Resolution, Backend, Audio, Microphone, Low memory, Clipboard) and the saved form values (`iruka.rdpForm`) survive the split.
- [ ] Connect, grid view, right-Alt view toggle and full screen behave exactly as before the split (including the deferred send of right Alt + key to the remote).
- [ ] Console badge text "Running" / "Idle 5m" / "Exited" and its timing.
- [ ] Disconnect messages now read "Disconnected (FreeRDP): …" / "Connection error (FreeRDP): …".

## Linux desktop

- [ ] A second start kills the running Iruka (KNOWN_ISSUES.md, 2026-10-24): add `tauri-plugin-single-instance` (focus the existing window) or turn off `enableGTKAppId`; rebuild the deb and check the dock still matches the window.

## Mac target (clintcan/macrdp)

- [ ] Microphone redirection.
- [ ] Resolution with and without `--hidpi` on a Retina display.
- [ ] Option+V does not paste (deferred; see KNOWN_ISSUES.md).

## Ubuntu GNOME Remote Desktop target

- [ ] Audio, microphone, clipboard and the Low memory option have only been verified against Windows; check them against GNOME Remote Desktop.

## Input

- [ ] Japanese keyboard: check the keys that have no US-layout counterpart (変換 / 無変換 / 半角全角 / カタカナひらがな).
- [ ] A settings screen for the view toggle key (today it is only `localStorage` key `iruka.viewToggleKey`).

## UI polish (deferred by the owner)

- [ ] Fine-tune the grid column slider.
- [ ] Fine-tune the console activity badge (the 2 s "Running" window, idle formatting).
- [ ] Dual-monitor support. Open question: two Iruka windows, with the grid on one monitor and a session in full screen on the other?

## Before a 1.0 release

- [ ] Pass the password to FreeRDP through the settings API instead of the in-process `/p:` argument (kept for now while debugging; FreeRDP prints a warning).
- [ ] Make the `iruka_perf` / `iruka_mem` debug logging opt-in (today the default filter in `src-tauri/src/lib.rs` enables it).
- [ ] Decide what to do about `/cert:ignore` (certificate verification is skipped; LAN use only).
- [ ] (Deferred by the owner, 2026-10-23.) Memory kept after a session closes (both clients; figures in docs/code-notes.md "Memory model"): on Linux about 600 MB stays after closing, mostly in fully resident glibc malloc arenas of the main process. Try `malloc_trim(0)` at session end or `M_ARENA_MAX`, re-measure, and look for a real leak with heaptrack.
- [ ] (Recorded only, by the owner's decision 2026-10-23; docs/realtime-kill.md.) Linux: the SIGKILL under load (WebKitGTK's real-time IPC threads hit `RLIMIT_RTTIME`; KNOWN_ISSUES.md). Candidate: demote the `ReceiveQueue` threads to `SCHED_OTHER` from the memory sampler thread.
- [ ] Audio playback from Ubuntu (GNOME Remote Desktop) stays on the remote although the client loads its audio backend (seen from the Windows client; microphone works). Postponed; compare with the Linux client (docs/windows-client-log.md).
- [ ] Try Iruka on KDE (or another non-GNOME desktop): window icon matching via `StartupWMClass`, the right-Alt toggle, clipboard.
- [ ] Windows installer: ship the FreeRDP / OpenSSL DLLs (with `legacy.dll`) in `bundle.resources`, and set `OPENSSL_MODULES` at startup (KNOWN_ISSUES.md).
  - Distribution plan: unsigned for now; publish both a Tauri NSIS installer and a portable zip (exe + DLLs, no install or admin rights; WebView2 is preinstalled on Windows 11). The README says: if SmartScreen warns, choose "More info → Run anyway".
  - A zip does not avoid SmartScreen: Explorer carries the Mark of the Web over to extracted files. Signing alone does not either: EV no longer grants instant reputation and every new build starts at zero.
  - For wider distribution later:
    - Azure Artifact Signing: paid (about $10/month), no free tier for open source; free, trial and sponsored Azure subscriptions are refused. Individuals only in the US/Canada; the list of eligible countries for organisations differs between sources (with or without Japan), so check Microsoft's page before relying on it.
    - SignPath Foundation (not a Microsoft programme; Microsoft's docs point open source projects to it): free for qualifying open source projects built in CI/CD. The publisher shown by Windows becomes "SignPath Foundation", and each release needs a manual approval on SignPath. Executables need "a certain verifiable reputation" judged by people at the first review, so not before Iruka has users (docs/windows-client-log.md).
    - The Microsoft Store.
- [ ] Console profiles: let the user pick the shell per console (PowerShell, cmd, WSL, bash, …). Today it is `$SHELL`, else `powershell.exe` on Windows and `bash` elsewhere.
- [ ] Automated UI tests; Rust unit tests exist only for small helpers.

## Done

- 2026-10-24: passwords of saved RDP connections in the OS credential store (`keyring` crate, opt-in "Save password"); worksets (save the open sessions and layout, restore them in order and only as many RDP sessions as the memory estimate allows, "Last open sessions" written automatically).

- [x] 2026-10-23: memory comparison with the Windows client (docs/code-notes.md "Memory model"): one 3840×2160 session costs about 550 MB on Linux, about 1.2 GB on Windows.
- [x] 2026-10-23: the cursor over the remote screen takes the remote's shape (FreeRDP pointer updates → CSS cursor; docs/code-notes.md "Cursor shape").
- [x] 2026-10-16: Linux packages: `.deb` (`scripts/make-deb.sh`, depends on Ubuntu's FreeRDP 3) and a self-contained tarball (`scripts/make-tarball.sh`: RPATH `$ORIGIN/lib`, FreeRDP 3 libraries in `lib/`, `check-deps.sh`).
- [x] 2026-10-16: Windows portable zip for the user's own use (docs/windows-client.md, "Portable zip").
- [x] 2026-10-16: Windows client against a Windows target: FreeRDP (NLA, audio, microphone, clipboard) and IronRDP; right Alt toggle, fullscreen and the drop-down toolbar work (docs/windows-client.md).
- [x] 2026-10-16: Windows build of the client, development build with FreeRDP 3.32.1 from vcpkg; connects to GNOME Remote Desktop (docs/windows-client.md).
- [x] 2026-10-13: Mac as a target through clintcan/macrdp, no Iruka changes (docs/mac-target.md).
- [x] 2026-10-13: segfault with two 4K sessions fixed (dynamic channels now run on the poll thread).
- [x] 2026-10-13: App.tsx split into modules; comments, UI and docs in English with `*_JA.md` twins.
