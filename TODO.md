*日本語版: [TODO_JA.md](TODO_JA.md)*

# TODO

Open tasks and things still to verify. Bugs that live outside Iruka (FreeRDP, the OS) are recorded in [KNOWN_ISSUES.md](KNOWN_ISSUES.md), not here. Design-level weak spots are described in [docs/code-notes.md](docs/code-notes.md).

## To verify after the 2026-10-13 refactor (App.tsx split, English UI)

A quick check on 2026-10-13 found no problems. Still to be checked more carefully:

- [ ] Connect form: the English labels (Resolution, Backend, Audio, Microphone, Low memory, Clipboard) and the saved form values (`iruka.rdpForm`) survive the split.
- [ ] Connect, grid view, right-Alt view toggle and full screen behave exactly as before the split (including the deferred send of right Alt + key to the remote).
- [ ] Console badge text "Running" / "Idle 5m" / "Exited" and its timing.
- [ ] Disconnect messages now read "Disconnected (FreeRDP): …" / "Connection error (FreeRDP): …".

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
- [ ] Windows build of the client (FreeRDP 3 has to be built or fetched for Windows).
- [ ] Automated UI tests; Rust unit tests exist only for small helpers.

## Done

- [x] 2026-10-13: Mac as a target through clintcan/macrdp, no Iruka changes (docs/mac-target.md).
- [x] 2026-10-13: segfault with two 4K sessions fixed (dynamic channels now run on the poll thread).
- [x] 2026-10-13: App.tsx split into modules; comments, UI and docs in English with `*_JA.md` twins.
