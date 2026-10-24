*日本語版: [linux-diagnostics-log_JA.md](linux-diagnostics-log_JA.md)*

# Linux diagnostics work log (trial and error)

A chronological record of finding out why Iruka's window vanished on the Ubuntu box, dead ends
included. The cleaned-up procedure is in [linux-diagnostics.md](linux-diagnostics.md); the
mechanism of the SIGKILL under load, with the Q&A, is in [realtime-kill.md](realtime-kill.md).

## 2026-10-23: Iruka disappears while OBS captures the screen

### Environment

- Ubuntu 26.04, kernel 7.0.0-38-generic, GNOME on Wayland, WebKitGTK 2.52.6, FreeRDP 3.32.1.
- Iruka 0.1.0 from the deb, started from the dock (so no terminal, no exit status).
- OBS Studio capturing the 3840×2160 display through PipeWire; 4 to 5 RDP sessions at 3840×2160.

### Step 1: the journal

- The owner's report was "it aborts". With nothing in a terminal, the first stop was the journal.
- `journalctl --since '2026-10-23 16:16:00'` returned "No entries" although the window clearly
  had lines; the reason was never found. Workaround: dump a wide range with `-o short-iso` and
  filter the ISO timestamps with awk. (Later, `--since "2026-10-23 16:16"` without seconds and
  `--since today` worked, so the seconds may have been the problem.)
- The awk summary of memory samples came out as `min=1024 max=509`: awk compared the fields as
  strings. Coerce with `u+0`.
- What the journal had: for each run, `Started app-gnome-Iruka-<pid>.scope` and at the end
  `app-gnome-Iruka-<pid>.scope: Consumed … 3.1G memory peak`. Nothing from Iruka, GTK, WebKit or
  FreeRDP just before the end. No apport report (`/var/crash` empty), no kernel `segfault` line, no
  systemd-oomd kill, cgroup `memory.events` `oom_kill 0`.
- Conclusion: a crash signal leaves a trace, so this was either a silent `exit()` or a SIGKILL.
  Six runs between 16:17 and 16:31 had lasted 1.5 to 4 minutes, the last 27 s.

### Step 2: get the exit status from a dock start

- A dock start has no terminal. Trick: a user copy of the deb's desktop entry in
  `~/.local/share/applications/Iruka.desktop` overrides the system one by file name; its `Exec`
  ran a script `~/.local/bin/iruka-gdb` with `gdb -batch -ex run -ex 'info threads' …` on
  `/usr/bin/iruka`, logging to `~/.local/state/iruka/gdb.log`.
- The owner asked whether the dock start really went through gdb (the icon looked the same). It
  did: same file name, same icon, the override is invisible from the dock.
- Next reproduction after 2 min 49 s with three 4K sessions: `Program terminated with signal
  SIGKILL, Killed. The program no longer exists.` gdb cannot say who sent it; the threads were
  gone before `info threads` ran.
- `/proc/sys/kernel/print_fatal_signals` does not exist; the file is `print-fatal-signals`
  (dashes), value 0. It would not have helped anyway: the kernel prints only for signals that dump
  core, and SIGKILL is not one of them (SIGXCPU is, but WebKit catches it).

### Step 3: who sends SIGKILL

- Only the kernel's `signal:signal_generate` tracepoint sees the sender. Claude Code cannot run
  `sudo`, so the owner ran bpftrace in their own terminal. Even `bpftrace --dry-run` for a syntax
  check needs root (it opens `/sys/kernel/tracing`).
- First attempt was a one-liner filtering `args->sig == 9`; the kept version
  (`~/.local/state/iruka/who-kills-iruka.bt`, now `scripts/diag/who-kills-iruka.bt`) also prints
  SIGTERM, SIGXCPU, SIGSEGV, SIGABRT, SIGBUS and `si_code`.
- The output "appeared late": bpftrace block-buffers stdout when it is not a terminal (the owner
  had it in a pipe). `-B line` fixes that; the service unit uses it.
- Result: `17:47:37 sig=9 to ReceiveQueue(pid 155573) from ReceiveQueue(pid 155355 tid 155573)
  code=128`. `code=128` is `SI_KERNEL`, and the "sender" is the victim's own thread: a kernel
  watchdog, not a process. No SIGXCPU before it.
- Confirmation on a live Iruka: `ps -L -o tid,cls,rtprio,comm` showed two `ReceiveQueue` threads
  on `RR` priority 5; `/proc/<pid>/limits` had `Max realtime timeout 160000 200000`; rtkit-daemon
  had logged "Successfully made thread … RT at priority 5" for them. Reading WebKit's
  `Source/WTF/wtf/glib/RealTimeThreads.cpp` showed who sets it and that there is no switch.
  Remmina (pid 5009) for comparison: no RT threads, limit unlimited.
- `pgrep -E` is not an option (harmless mistake).
- Owner's decision: record only (project rule for problems outside Iruka). The gdb launcher and
  its desktop override were removed; the bpftrace script stayed.

### Evening: the no-code workaround and a second dock entry

- `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent` hides the system bus; WebKit cannot reach
  RealtimeKit; no RT threads, no limit (checked at start-up). Kept as a script
  `~/.local/bin/iruka-no-realtime` plus a desktop entry "Iruka (no realtime)" without
  `StartupWMClass`, so the running window keeps attaching to the normal entry.
- Verified in real use with OBS: no kill, but Iruka responds noticeably slower while OBS runs;
  cause not isolated (OBS load against ordinary-priority IPC threads).

## 2026-10-24: "maybe it died while I was using it"

### Motivation

- The owner had started using Iruka for real. Six runs since 05:05 (scope lines in the user
  journal), the longest 08:00 to 10:16 with a 1.8 GB peak; no exit status for any of them, so no
  way to tell a close from a kill after the fact. No OOM lines in the kernel log.
- Three wishes: see the exit status without starting from a terminal, a `--debug` switch, and
  the bpftrace one-liner "into a log somehow".

### Findings

- **`--debug` is unnecessary**: Iruka's stderr already lands in the user journal when started
  from the dock, with the desktop entry's name as identifier (`-t Iruka.desktop`), and the debug
  filter is on by default. 377,546 lines since the previous day, mostly `iruka_perf`.
- `journalctl -u 'app-gnome-*'` on the system journal fails with "No data available": GNOME's
  app scopes live in the user journal (`--user`).
- The scope's `Consumed` line gives start, end, CPU time and peak memory but **no exit status**:
  a scope does not have a main process.
- FreeRDP's WLog lines (stdout) reached the journal 80 s late in one burst, timestamps inside the
  lines showing when they were written: stdout is block-buffered without a terminal. `tracing`
  lines on stderr arrive immediately.

### The wrapper, and an accident that found a bug

- `~/.local/bin/iruka-logged` runs `/usr/bin/iruka`, decodes the status (> 128 means a signal;
  `kill -l N` gives the name) and appends a line to `~/.local/state/iruka/exit.log` and to the
  journal through `systemd-cat -t iruka-exit`. The deb's desktop entry is overridden to use it;
  `iruka-no-realtime` now execs it as well, so both entries are logged with a `mode` field.
- Tests with `kill -9` and `kill -TERM` on a fresh instance produced
  `killed by signal 9 (SIGKILL)` and `killed by signal 15 (SIGTERM)`.
- The bpftrace watch became a system service (`iruka-kill-watch.service`, `bpftrace -q -B line`,
  output to the system journal, readable by the adm group) with an install script for `sudo`.
- **Accident**: the owner had meanwhile started Iruka from the dock (10:36:51) and was using it with
  two RDP sessions. A test start of the new launcher at 10:38:28 made *their* instance exit with
  code 101 while the test instance exited 0 at once. The journal had the reason:
  `thread 'main' panicked at tauri-2.11.5/src/app.rs:1425: Failed to setup app: a webview with
  label 'main' already exists`. With `enableGTKAppId: true`, the second process is a GApplication
  remote instance: it forwards `activate` to the running one and exits 0; the running one gets a
  second `Ready` from the event loop, Tauri runs `setup` again, the `main` window already exists,
  panic. So **starting Iruka a second time kills the running Iruka** (KNOWN_ISSUES.md; fix
  candidates in TODO.md). Lesson for the tests here: never start a test instance while the owner's
  Iruka runs; `pgrep -x iruka` first.
