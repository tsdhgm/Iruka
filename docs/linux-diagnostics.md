*日本語版: [linux-diagnostics_JA.md](linux-diagnostics_JA.md)*

# When Iruka disappears on Linux: finding out why

A how-to for the Ubuntu (GNOME, Wayland) box, written after two rounds of chasing vanished
Iruka windows: the SIGKILL under load (docs/realtime-kill.md) and a run that ended while the owner
was using it. The trial and error behind it is in [linux-diagnostics-log.md](linux-diagnostics-log.md).
The helpers live in `scripts/diag/`.

## 1. What leaves a trace, and where

| How it ended | Exit status of `iruka` | Other traces |
|---|---|---|
| Closed normally | 0 | nothing else |
| Second instance started while one runs (Tauri setup panic, KNOWN_ISSUES.md) | 101 | `thread 'main' panicked … a webview with label 'main' already exists` on stderr |
| Rust panic or `abort()` in FreeRDP | 101 (panic) or 134 (SIGABRT) | panic message on stderr; a core / apport report for SIGABRT |
| Segfault | 139 (SIGSEGV) | kernel `segfault at …` line in `journalctl -k`; `coredumpctl list iruka` |
| Out of memory | 137 (SIGKILL) | `Out of memory: Killed process` in `journalctl -k`, or a systemd-oomd line |
| `RLIMIT_RTTIME` watchdog (docs/realtime-kill.md) | 137 (SIGKILL) | **nothing**, except the bpftrace watch (section 4): `code=128`, sender is the victim's own `ReceiveQueue` thread |
| Logout, or killed by hand | 143 (SIGTERM) or 137 | bpftrace watch shows `code=0` and the sender (gnome-session, systemd, bash) |

Statuses above 128 are 128 + signal number; the wrapper below prints the signal name.

## 2. What the journal already has (nothing to install)

Started from the dock, Iruka runs in a systemd user scope and its stderr goes to the user journal
under the desktop entry's name:

```sh
# Iruka's own log (tracing, FreeRDP WLog); drop the frame log for readability
journalctl --user -t Iruka.desktop -o short-iso --since "1 hour ago" | grep -v iruka_perf
# started from the "Iruka (no realtime)" entry
journalctl --user -t iruka-no-realtime.desktop -o short-iso --since "1 hour ago"
# start and end of every run, with its peak memory (no exit status: scopes do not track one)
journalctl --user -o short-iso --since today | grep -E "app-gnome-Iruka-[0-9]+\.scope"
```

Pitfalls: `--since` takes `"YYYY-MM-DD HH:MM"` or words like `today`, `"1 hour ago"`; the GNOME
scopes are in the **user** journal (`--user`), `journalctl -u 'app-gnome-*'` on the system journal
says "No data available". FreeRDP's WLog lines go to stdout, which is block-buffered when it is not a
terminal, so they appear in the journal late and in bursts; Iruka's `tracing` lines (stderr) are
immediate. The debug logging (`iruka_perf`, `iruka_mem`) is on by default (docs/code-notes.md),
so there is no `--debug` option to pass; `IRUKA_LOG` narrows it.

## 3. Record the exit status: `iruka-logged`

```sh
scripts/diag/install-launchers.sh          # --remove undoes it
```

installs `~/.local/bin/iruka-logged`, which runs `/usr/bin/iruka` and appends one line per run to
`~/.local/state/iruka/exit.log` and to the journal (`journalctl --user -t iruka-exit`):

```
start=2026-10-24 10:27:07 end=2026-10-24 10:27:11 mode=normal killed by signal 9 (SIGKILL)
start=2026-10-24 10:36:51 end=2026-10-24 10:38:28 mode=normal exit code 101
```

It also writes a user override of the deb's desktop entry (`~/.local/share/applications/Iruka.desktop`,
same name, icon and `StartupWMClass`, only `Exec` points at the wrapper), the `iruka-no-realtime`
launcher (D-Bus system bus hidden, docs/realtime-kill.md) and the second dock entry
"Iruka (no realtime)", which goes through the same wrapper (`mode=no-realtime`).

## 4. Record who sends the signal: the bpftrace watch

SIGKILL cannot be caught and leaves no trace of its sender; only the kernel's signal tracepoint
sees it. `scripts/diag/who-kills-iruka.bt` prints every fatal signal on the machine (SIGKILL,
SIGTERM, SIGXCPU, SIGSEGV, SIGABRT, SIGBUS) with victim, sender and `si_code`.
`scripts/diag/iruka-kill-watch.service` runs it as a system service (root), output to the system
journal:

```sh
sudo scripts/diag/install-kill-watch.sh                  # --remove undoes it
journalctl -u iruka-kill-watch -o short-iso -f           # adm group: no sudo to read
journalctl -u iruka-kill-watch -o short-iso | grep -E 'iruka|ReceiveQueue'
```

Reading a line: `code=0` is `kill()` from user space and "from" names the sender; `code=128` is
`SI_KERNEL`, the kernel generated it and "from" is only the task that happened to run, which for the
`RLIMIT_RTTIME` watchdog is the victim's own `ReceiveQueue` thread. Logout produces a burst of
SIGTERM lines; that is normal. One-off alternative, in a terminal: `sudo bpftrace -B line
scripts/diag/who-kills-iruka.bt` (`-B line`, otherwise the output is buffered until exit).

## 5. Other checks

```sh
journalctl -k --since today | grep -iE "oom|killed process|segfault"   # kernel: OOM, segfault
journalctl --user -u systemd-oomd --since today; journalctl -u systemd-oomd --since today
coredumpctl list iruka; ls /var/crash                                  # cores, apport
ps -L -o tid,cls,rtprio,comm -p "$(pgrep -x iruka)" | grep -E 'RR|FF'  # real-time threads
grep realtime "/proc/$(pgrep -x iruka)/limits"                        # RLIMIT_RTTIME
journalctl -u rtkit-daemon --since today | grep "$(pgrep -x iruka)"    # RealtimeKit promotions
```

## 6. Removing everything

```sh
scripts/diag/install-launchers.sh --remove
sudo scripts/diag/install-kill-watch.sh --remove
rm -rf ~/.local/state/iruka
```
